#!/usr/bin/env bash
#
# Fetch the Blender Foundation's open films from blender.org, transcode each
# to one 720p HLS rendition, and upload them to the programmes bucket
# (infra/programmes.tf). The television plays them from there
# (apps/tv-vega/src/catalog/catalog.ts).
#
#   scripts/publish-programmes.sh fetch       download the originals
#   scripts/publish-programmes.sh transcode   originals -> HLS, in .programmes/out
#   scripts/publish-programmes.sh upload      .programmes/out -> S3
#   scripts/publish-programmes.sh all         the three, in order
#
# The films are Creative Commons Attribution 3.0. The attribution each one
# requires is in catalog.ts and on the television's pause notice.
#
# ffmpeg runs in a container (mwader/static-ffmpeg, the same build the live
# bridge uses), so nothing needs installing beyond Docker and the AWS CLI.
# One rendition, not a ladder: the television is on the household's own
# broadband, and one encode means one measured credits position per film.
#
# Upload needs AWS credentials for the account (AWS_PROFILE=wick-dev on a
# laptop) and the bucket name: PROGRAMMES_BUCKET, or `terraform output
# -raw programmes_bucket` in infra/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${ROOT}/.programmes"
SRC="${WORK}/src"
OUT="${WORK}/out"
FFMPEG_IMAGE="mwader/static-ffmpeg:7.1"

# id | what to download | the file inside it
PROGRAMMES=(
  "big-buck-bunny|https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_720p_h264.mov.zip|big_buck_bunny_720p_h264.mov"
  "sintel|https://download.blender.org/durian/movies/Sintel.2010.720p.mkv.zip|Sintel.2010.720p.mkv"
  "tears-of-steel|https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov|tears_of_steel_720p.mov"
)

fetch() {
  mkdir -p "${SRC}"
  for entry in "${PROGRAMMES[@]}"; do
    IFS='|' read -r id url file <<<"${entry}"
    if [[ -f "${SRC}/${file}" ]]; then
      echo "have ${file}"
      continue
    fi
    echo "fetching ${id}"
    if [[ "${url}" == *.zip ]]; then
      curl -fSL -C - -o "${SRC}/${id}.zip" "${url}"
      unzip -o -q "${SRC}/${id}.zip" -d "${SRC}"
    else
      curl -fSL -C - -o "${SRC}/${file}" "${url}"
    fi
  done
}

ffmpeg_in_container() {
  docker run --rm -v "${WORK}:/work" "${FFMPEG_IMAGE}" -hide_banner -loglevel error -nostdin "$@"
}

transcode() {
  for entry in "${PROGRAMMES[@]}"; do
    IFS='|' read -r id _url file <<<"${entry}"
    if [[ -f "${OUT}/${id}/index.m3u8" ]]; then
      echo "have ${id}/index.m3u8"
      continue
    fi
    echo "transcoding ${id}"
    rm -rf "${OUT:?}/${id}"
    mkdir -p "${OUT}/${id}"
    # H.264 Main 3.1 + stereo AAC in MPEG-TS: what the Vega player is known
    # to decode (FL-018). A keyframe every 2s and 6s segments, so a 30-second
    # skip lands quickly. Scaled to fit 1280x720 without stretching.
    ffmpeg_in_container -i "/work/src/${file}" \
      -map 0:v:0 -map 0:a:0 -sn \
      -vf "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p" \
      -c:v libx264 -profile:v main -level 3.1 -preset medium -crf 21 -maxrate 3500k -bufsize 7000k \
      -force_key_frames "expr:gte(t,n_forced*2)" \
      -c:a aac -ac 2 -b:a 128k -ar 48000 \
      -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_filename "/work/out/${id}/seg_%04d.ts" \
      "/work/out/${id}/index.m3u8"
  done
}

upload() {
  local bucket="${PROGRAMMES_BUCKET:-$(terraform -chdir="${ROOT}/infra" output -raw programmes_bucket)}"
  echo "uploading to s3://${bucket}"
  # The films never change once published: cache them for a year. The
  # playlist is short-lived so a re-encode is picked up.
  aws s3 sync "${OUT}" "s3://${bucket}" --exclude "*" --include "*.ts" \
    --content-type "video/mp2t" --cache-control "public, max-age=31536000, immutable"
  aws s3 sync "${OUT}" "s3://${bucket}" --exclude "*" --include "*.m3u8" \
    --content-type "application/vnd.apple.mpegurl" --cache-control "public, max-age=300"
}

case "${1:-}" in
  fetch) fetch ;;
  transcode) transcode ;;
  upload) upload ;;
  all) fetch && transcode && upload ;;
  *)
    echo "usage: $0 fetch|transcode|upload|all" >&2
    exit 2
    ;;
esac
