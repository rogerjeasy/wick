# This deployment's own values, read by every apply — CI's and a laptop's —
# so the two never disagree. A fork deploying its own Wick changes them.

# The family app's origin (the sim_alexa_url output). The Wick server cannot
# read it from the distribution: that would be a cycle (the distribution's CSP
# names the server). A visit pass's link is <this>/visit.html#<token>
# (infra/mcp.tf, make_visit_pass).
family_app_url = "https://dmaz25jvryojp.cloudfront.net"
