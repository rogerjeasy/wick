# door-describe

Describe what is visibly at the door, for a resident deciding whether the trip is
worth making.

## Constraints (validated on output, not merely requested)
- Present tense. One sentence. Maximum 14 words.
- Observable facts only. No inference about intent, mood, purpose or errand.
- Never name a person unless supplied in the household roster.
- If uncertain, return nothing. Silence beats a wrong description.

## Good
- "A man in a delivery uniform is at the door holding a large box."
- "Two people are at the door; one is holding a clipboard."

## Bad
- "A delivery driver is trying to deliver a parcel."   <- infers intent
- "Someone suspicious is lingering."                    <- judgement
- "Motion detected."                                    <- useless
