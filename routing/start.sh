#!/usr/bin/env bash
# EVROUTE's start for the Valhalla service (see Dockerfile and README.md).
#
# Building Thailand's routing tiles needs more room for its working files than the 5 GB volume a Hobby
# plan allows ("No space left on device" half way through). So the build runs on the container's own disk
# (/build, up to 100 GB on Hobby, gone when the container stops) and only what serving needs goes on the
# volume: the tiles packed into one file (valhalla_tiles.tar) and the config.
#
# Valhalla's own start scripts aren't used: they keep everything on the volume, download the map only
# when no map is there and never check the download finished ("PBF error: unexpected EOF" after a cut-off
# start), and skip steps whose files already exist, so half-written files broke every later start.
#
# Here, unless the last build finished (the marker below): empty the volume, download the map whole
# (checked against Geofabrik's md5), build, pack the tiles onto the volume, then mark it finished. Every
# start after that serves straight from the volume. force_rebuild=True builds again with a fresh map.
set -o errexit -o pipefail -o nounset

CF=/custom_files                     # the volume
B=/build                             # the container's own disk
CONF="$CF/valhalla.json"
TAR="$CF/valhalla_tiles.tar"
READY="$CF/.evroute-build-finished"
THREADS="${server_threads:-2}"       # serving
BUILD_THREADS="${build_threads:-4}"  # building

echo "EVROUTE: volume $(df -h "$CF" | awk 'NR==2 {print $3 " used of " $2}')"

if [ "${force_rebuild:-False}" = True ] || [ ! -f "$READY" ] || [ ! -f "$TAR" ] || [ ! -f "$CONF" ]; then
  echo "EVROUTE: no finished build on the volume (or force_rebuild=True): building from scratch"
  find "$CF" -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +
  rm -rf "$B"
  mkdir -p "$B"
  echo "EVROUTE: build disk $(df -h "$B" | awk 'NR==2 {print $4 " free"}')"

  maps=""
  for url in $tile_urls; do
    pbf="$B/$(basename "$url")"
    for try in 1 2 3; do
      echo "EVROUTE: downloading $url (try $try)"
      md5=$(curl -fsSL --retry 3 --max-time 60 "$url.md5" | cut -d' ' -f1 || true)
      if curl -fsSL --retry 3 --retry-delay 15 -o "$pbf.part" "$url"; then
        got=$(md5sum "$pbf.part" | cut -d' ' -f1)
        if [ -z "$md5" ]; then
          echo "EVROUTE: no md5 from Geofabrik; the download finished, using it"
          mv "$pbf.part" "$pbf"
          break
        elif [ "$got" = "$md5" ]; then
          echo "EVROUTE: map complete ($(du -h "$pbf.part" | cut -f1), md5 matches)"
          mv "$pbf.part" "$pbf"
          break
        fi
        # Geofabrik publishes a new map daily; a mismatch is usually that, so try again
        echo "EVROUTE: md5 doesn't match ($got, expected $md5)"
      fi
      rm -f "$pbf.part"
      sleep 30
    done
    if [ ! -f "$pbf" ]; then
      echo "EVROUTE: couldn't download a complete map from $url" >&2
      exit 1
    fi
    maps="$maps $pbf"
  done

  # tiles are built in $B/tiles and packed into $TAR on the volume; Valhalla serves from the tar
  # whenever it's there, so tile_dir no longer matters once the build is done
  valhalla_build_config \
    --mjolnir-tile-dir "$B/tiles" \
    --mjolnir-tile-extract "$TAR" \
    --mjolnir-admin "$B/admins.sqlite" \
    --mjolnir-timezone "$B/timezones.sqlite" \
    --mjolnir-traffic-extract "$B/traffic.tar" \
    --mjolnir-concurrency "$BUILD_THREADS" > "$B/valhalla.json"
  # road speeds by road type and country (as Valhalla's own scripts do); without it, Valhalla's defaults
  if curl -fsSL --retry 3 --max-time 120 -o "$B/default_speeds.json" "${default_speeds_config_url:-}"; then
    jq --arg d "$B/default_speeds.json" '.mjolnir.default_speeds_config = $d' "$B/valhalla.json" | sponge "$B/valhalla.json"
  else
    echo "EVROUTE: couldn't download default speeds; building with Valhalla's defaults"
  fi

  echo "EVROUTE: building country borders (which side of the road Thailand drives on)"
  valhalla_build_admins --config "$B/valhalla.json" $maps
  echo "EVROUTE: building routing tiles"
  valhalla_build_tiles -c "$B/valhalla.json" $maps
  echo "EVROUTE: packing tiles onto the volume"
  valhalla_build_extract -c "$B/valhalla.json" -v --overwrite

  cp "$B/valhalla.json" "$CONF"
  touch "$READY"
  rm -rf "$B"
  echo "EVROUTE: build finished ($(du -h "$TAR" | cut -f1) of tiles on the volume)"
fi

echo "EVROUTE: serving on port 8002"
exec valhalla_service "$CONF" "$THREADS"
