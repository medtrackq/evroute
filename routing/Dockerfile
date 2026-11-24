# EVROUTE's own route planner: the official Valhalla image, for Thailand only. A Railway service with
# Root Directory "routing" and a volume at /custom_files (see README.md). On first start it downloads
# Thailand from OpenStreetMap (Geofabrik) and builds its routing tiles (about an hour), keeps them on
# the volume, then answers on port 8002 on Railway's private network only; server.mjs reaches it
# through VALHALLA_URL and falls back to the public FOSSGIS server when it doesn't answer.
FROM ghcr.io/valhalla/valhalla-scripted:3.9.3

# The image's own start scripts aren't used (start.sh says why); only its Valhalla programs
# server_threads: for answering routes; the host's core count otherwise, too many for a small service
# build_threads: for building, on the container's own disk; the extra cores are only used for that hour
# force_rebuild=True (a Railway variable): build again with a fresh map (README.md)
ENV tile_urls=https://download.geofabrik.de/asia/thailand-latest.osm.pbf \
    server_threads=2 \
    build_threads=4

EXPOSE 8002

COPY start.sh /evroute/start.sh
ENTRYPOINT ["bash", "/evroute/start.sh"]
CMD []
