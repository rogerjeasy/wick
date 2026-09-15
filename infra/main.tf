data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name   = "wick"
  prefix = var.environment == "dev" ? "wick" : "wick-${var.environment}"

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}
