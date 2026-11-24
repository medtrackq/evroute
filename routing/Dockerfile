# EVROUTE's own route planner: the official Valhalla image, for Thailand only. A Railway service with
# Root Directory "routing" and a volume at /custom_files (see README.md). On first start it downloads
# Thailand from OpenStreetMap (Geofabrik) and builds its routing tiles (tens of minutes), keeps them on
# the volume, then answers on port 8002 on Railway's private network only; server.mjs reaches it
# through VALHALLA_URL and falls back to the public FOSSGIS server when it doesn't answer.
FROM ghcr.io/valhalla/valhalla-scripted:3.9.3

# use_tiles_ignore_pbf=False: build again unless the tiles finished building from this map file.
#   start.sh goes further: unless the last build finished, it empties the volume and downloads the map
#   whole first (a cut-off start left half a map: "PBF error: unexpected EOF"). force_rebuild=True also
#   starts from empty, so it downloads a fresh map
# server_threads: the host's core count otherwise, too many for the memory a small service has
# build_admins: country data, so it knows Thailand drives on the left
# build_time_zones=False: the app sends no departure times to Valhalla; it saves disk on the 5 GB volume
ENV tile_urls=https://download.geofabrik.de/asia/thailand-latest.osm.pbf \
    use_tiles_ignore_pbf=False \
    server_threads=2 \
    build_admins=True \
    build_time_zones=False \
    build_elevation=False \
    build_transit=False \
    serve_tiles=True

EXPOSE 8002

# start.sh checks the volume, runs Valhalla's own scripts to build, then serves (see start.sh)
COPY start.sh /evroute/start.sh
ENTRYPOINT ["bash", "/evroute/start.sh"]
CMD []
