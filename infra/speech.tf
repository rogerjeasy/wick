# ---------------------------------------------------------------------------
# Read to me — a card read aloud, when she asks
# (packages/contracts/src/speech.ts).
#
# While a card is on her screen, the Play key asks for it to be read. The
# function that answers her television (the same handler behind both
# channels: infra/transport.tf ws_route, infra/iot.tf iot_events) has the
# card's words spoken by Amazon Polly, keeps the reading for a day, and
# answers that one television with a short-lived address of it
# (services/edge-device/lambda/speech.mjs).
#
# Where a reading is kept: the media bucket (infra/core.tf), under `tts/`,
# as `tts/<household>/<hash>.mp3` — the hash is of the language, the voice
# and the exact words, so the same card read twice is made once. It is a
# cache of words already on her screen, nothing more: the bucket lets each
# go after one day (the `tts-1d` rule in infra/core.tf), and nothing else
# ever reads it.
#
# What the two functions may do, and no more:
#
#   - ask Polly to speak (SynthesizeSpeech has no resource to scope to);
#   - put a reading under `tts/`, and get one — which is also what a HEAD
#     ("is it kept already?") and a signed address need. Not the rest of the
#     bucket: the door's snapshots and the live view beside it are out of
#     reach. And not a listing: so a reading that is not there answers "403",
#     not "404" — speech.mjs takes any failure to find one as "make it".
#
# The television reads the mp3 through an address signed by the function
# (presign.mjs), good for five minutes (SPEECH_URL_TTL_SEC). Nothing is
# public, and there is no bucket-policy grant.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "edge_speech" {
  statement {
    sid       = "SpeakTheCardOnHerScreen"
    actions   = ["polly:SynthesizeSpeech"]
    resources = ["*"]
  }

  statement {
    sid       = "KeepAReadingForADayAndSignItsAddress"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.media.arn}/tts/*"]
  }
}

resource "aws_iam_role_policy" "ws_route_speech" {
  name   = "${local.prefix}-ws-route-speech"
  role   = aws_iam_role.ws_route.id
  policy = data.aws_iam_policy_document.edge_speech.json
}

resource "aws_iam_role_policy" "iot_events_speech" {
  name   = "${local.prefix}-iot-events-speech"
  role   = aws_iam_role.iot_events.id
  policy = data.aws_iam_policy_document.edge_speech.json
}
