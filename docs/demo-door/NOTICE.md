# The stand-in doorbell's pictures

These five pictures are what a demo home's stand-in doorbell shows
(`packages/contracts/src/demoDoor.ts`). They are not photographs. Nobody in
them is a real person, and no house in them is a real house.

They were made on 2026-10-14 with **Stable Image Ultra**
(`stability.stable-image-ultra-v1:1`) on Amazon Bedrock, in us-west-2, then
scaled to 960 pixels wide as JPEG. Amazon Nova Canvas and Titan Image
Generator v2 were tried first: both answered that the model had reached the
end of its life.

| File | Who is at the door | Seed |
| --- | --- | --- |
| `carer.jpg` | the demo home's carer | 4101 |
| `parcel.jpg` | a parcel delivery | 4102 |
| `stranger.jpg` | somebody she does not know | 4203 |
| `nobody.jpg` | nobody: movement, and nobody rings | 4104 |
| `arranged.jpg` | the visitor a family member arranged (made 2026-10-18) | 4106 |

Aspect ratio 16:9, output JPEG. Every prompt began with the frame below, and
ended with the sentence in the second table.

`carer`, `parcel`, `nobody` and `arranged`:

> Photo from a video doorbell camera mounted beside a front door, very
> wide-angle fisheye lens with barrel distortion, looking straight out at the
> doorstep of a modest brick terraced house in an English town, garden path
> and low hedge behind, soft overcast daylight, slightly soft focus and muted
> colours like a security camera frame.

`stranger`:

> Photo taken by a video doorbell camera mounted on a front door frame at
> chest height, very wide-angle fisheye lens with barrel distortion, looking
> outward from the house: a short front garden path, a low brick wall and
> hedge, and a quiet residential street of brick terraced houses beyond, soft
> overcast daylight, slightly soft focus and muted colours like a security
> camera frame, seen from slightly above.

| File | The rest of the prompt |
| --- | --- |
| `carer.jpg` | A woman in her forties stands on the doorstep facing the door, wearing a plain light blue care worker's tunic with no markings and dark trousers, a small plain grey bag over her shoulder. |
| `parcel.jpg` | A delivery driver stands on the doorstep facing the door, wearing a plain dark green jacket with no markings, holding a plain unmarked brown cardboard parcel in both hands. |
| `stranger.jpg` | A middle-aged man stands on the doorstep about a metre from the camera, facing it, wearing a plain grey raincoat, holding a plain clipboard. |
| `nobody.jpg` | Nobody is there: an empty doorstep, a doormat and a potted plant beside the door, the garden path empty. |
| `arranged.jpg` | A tradesman in his fifties stands on the doorstep facing the door, wearing plain navy work overalls with no markings, holding a plain grey metal toolbox in one hand. |

Negative prompt, for `carer`, `parcel` and `nobody` (for `arranged`, the same with "emblem, patch, shopping bag" added):

> text, words, letters, numbers, timestamp, logo, brand, badge, watermark,
> signage, uniform logo, cartoon, illustration, painting, close-up portrait

and for `stranger`, the same with "writing, house numbers, street signs"
added.

They are published here so the television can load them like any picture
from a door, and copied beside the Door agent's bundle
(`scripts/build-lambda.mjs`) so its vision step describes the very bytes the
television shows. The sentence under each picture on the television is the
vision model's, made when the doorbell is rung, not written here.
