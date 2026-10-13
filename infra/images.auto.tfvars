# The images the stack runs, pinned in git so every apply — a laptop's or CI's
# deploy-edge/deploy-agent on a push to main — deploys exactly these, never
# whatever a moving `latest` tag points at. scripts/push-agent-image.sh pushes
# both images (wick-agents, wick-live-bridge) under one tag and rewrites this.
agent_image_tag = "6c16ea0"
