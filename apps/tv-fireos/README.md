# tv-fireos — Fire OS companion build

**Build LAST.** After Tier 0 and Tier 1 run on Vega and the demo is filmed.

## Why it exists

Vega ships on the newest hardware; Fire OS is the installed base. Shipping both
from one repository widens the addressable market enormously and lets the
submission claim the new platform *and* reach.

## What Fire OS gives that Vega does not

- **Amazon Device Messaging (ADM)** push
- Foreground services — a genuinely always-on surface
- Camera2 / UVC webcam, microphone, BLE
- The Fire TV Integration SDK

None of Wick's Tier 0 features depend on any of it. This build is reach, not
capability.

## Ground rules

The same invariants apply (`../../AGENTS.md`). In particular INV-1: Fire OS has a
real keystore, and it is still not somewhere a Ring credential belongs.
