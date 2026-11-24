#!/usr/bin/env bash
# EVROUTE's start for the Valhalla service, run before Valhalla's own scripts (see Dockerfile).
#
# Valhalla's scripts download the map only when no .pbf is on the volume, never check the download
# finished, and skip any step whose file already exists. So a start that was cut off (a redeploy, a full
# disk, a dropped connection) leaves half a file that every later start trips over:
# "PBF error: unexpected EOF", "Invalid JSON in config", tiles it can't load.
#
# Here: unless the last build finished (the marker below), start from an empty volume, download the map
# whole (checked against Geofabrik's md5), let Valhalla's scripts build without serving, mark the build
# finished, then serve. force_rebuild=True also starts from empty, so it downloads a fresh map.
set -o errexit -o pipefail -o nounset

CF=/custom_files
READY="$CF/.evroute-build-finished"

echo "EVROUTE: volume $(df -h "$CF" | awk 'NR==2 {print $3 " used of " $2}')"

if [ "${force_rebuild:-False}" = True ] || [ ! -f "$READY" ]; then
  echo "EVROUTE: no finished build on the volume (or force_rebuild=True): emptying it and building from scratch"
  find "$CF" -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +

  for url in $tile_urls; do
    pbf="$CF/$(basename "$url")"
    for try in 1 2 3; do
      echo "EVROUTE: downloading $url (try $try)"
      md5=$(curl -fsSL --retry 3 --max-time 60 "$url.md5" | cut -d' ' -f1 || true)
      # .part doesn't end in .pbf, so Valhalla's scripts never see a half download
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
  done
fi

# Valhalla's own scripts: build anything missing (nothing, after a finished build), then stop
serve_tiles=False /valhalla/scripts/docker-entrypoint.sh build_tiles
touch "$READY"
echo "EVROUTE: build finished, serving on port 8002"
exec valhalla_service "$CF/valhalla.json" "${server_threads:-2}"
