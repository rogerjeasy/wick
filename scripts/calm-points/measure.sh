#!/usr/bin/env bash
#
# Measures, for each published programme, the two things a calm point is
# chosen from (scripts/calm-points/choose.ts):
#
#   - where the picture changes: shots, fades through black and the start of
#     the end credits, from Amazon Rekognition's video segment detection;
#   - where the sound drops away: from ffmpeg, judged against the film's own
#     loudness (EBU R 128), not one level for every film.
#
# Both are measured on the encode the television plays (.programmes/out, made
# by scripts/publish-programmes.sh), so every time is a position in that
# stream. The raw results go to .programmes/calm/; `npm run calm:build` turns
# them into the committed measurements and the television's calm points.
#
#   scripts/calm-points/measure.sh                 every programme
#   scripts/calm-points/measure.sh big-buck-bunny  one
#
# Needs ffmpeg, the AWS CLI and credentials for the account (AWS_PROFILE=
# wick-dev on a laptop). Rekognition reads a video from S3, so each film is
# put under analysis/ in the programmes bucket for the length of its job and
# removed again. Cost: about ten cents a film.
set -euo pipefail
export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${ROOT}/.programmes/out"
CALM="${ROOT}/.programmes/calm"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${PROGRAMMES_BUCKET:-$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'wick-programmes')].Name | [0]" --output text)}"

# Quiet is judged against the film's own loudness: this far below it, for at
# least six tenths of a second. One level for every film finds nothing in a
# loud one (Tears of Steel is 6 dB louder than Big Buck Bunny throughout).
QUIET_BELOW_OWN_LOUDNESS_DB=14
QUIET_FOR_S=0.6
# Rekognition: black means black (a fade, not a dark scene), and a shot change it is fairly sure of.
FILTERS="TechnicalCueFilter={MinSegmentConfidence=80,BlackFrame={MaxPixelThreshold=0.2,MinCoveragePercentage=99}},ShotFilter={MinSegmentConfidence=60}"

ids=("$@")
if [[ ${#ids[@]} -eq 0 ]]; then
  for dir in "${OUT}"/*/; do ids+=("$(basename "${dir}")"); done
fi

mkdir -p "${CALM}"
for id in "${ids[@]}"; do
  playlist="${OUT}/${id}/index.m3u8"
  [[ -f "${playlist}" ]] || { echo "no encode for ${id}: run scripts/publish-programmes.sh transcode" >&2; exit 1; }

  echo "${id}: listening for where the sound drops away"
  loudness="$(ffmpeg -hide_banner -nostats -i "${playlist}" -vn -af "ebur128=peak=none:framelog=quiet" -f null - 2>&1 \
    | tail -12 | awk '/^ +I:/ { print $2; exit }')"
  quiet="$(awk -v l="${loudness}" -v d="${QUIET_BELOW_OWN_LOUDNESS_DB}" 'BEGIN { printf "%.1f", l - d }')"
  {
    echo "# loudness ${loudness} LUFS; quiet below ${quiet} dB"
    ffmpeg -hide_banner -nostats -i "${playlist}" -vn -af "silencedetect=noise=${quiet}dB:d=${QUIET_FOR_S}" -f null - 2>&1 | grep -E "silence_(start|end)"
  } >"${CALM}/${id}.silences.txt"

  if [[ -f "${CALM}/${id}.rekognition.json" && -z "${REMEASURE_PICTURE:-}" ]]; then
    echo "${id}: have the picture measurement (REMEASURE_PICTURE=1 to ask Rekognition again)"
    continue
  fi

  echo "${id}: asking Rekognition where the picture changes"
  # The same stream in one file: the segments are copied, not encoded again, so the times are unchanged.
  ffmpeg -hide_banner -loglevel error -y -i "${playlist}" -c copy -movflags +faststart "${CALM}/${id}.mp4"
  aws s3 cp "${CALM}/${id}.mp4" "s3://${BUCKET}/analysis/${id}.mp4" --region "${REGION}" --no-progress >/dev/null
  job="$(aws rekognition start-segment-detection --region "${REGION}" \
    --video "S3Object={Bucket=${BUCKET},Name=analysis/${id}.mp4}" \
    --segment-types TECHNICAL_CUE SHOT --filters "${FILTERS}" --query JobId --output text)"
  status=IN_PROGRESS
  while [[ "${status}" == IN_PROGRESS ]]; do
    sleep 10
    status="$(aws rekognition get-segment-detection --region "${REGION}" --job-id "${job}" --max-results 1 --query JobStatus --output text)"
  done
  aws s3 rm "s3://${BUCKET}/analysis/${id}.mp4" --region "${REGION}" >/dev/null
  rm -f "${CALM}/${id}.mp4"
  [[ "${status}" == SUCCEEDED ]] || { echo "${id}: segment detection ${status}" >&2; exit 1; }
  aws rekognition get-segment-detection --region "${REGION}" --job-id "${job}" --max-results 1000 --output json >"${CALM}/${id}.rekognition.json"
  echo "${id}: measured"
done
