# ---------------------------------------------------------------------------
# Accounts. Who a family member is: an email address and a password, kept by
# Amazon Cognito and nowhere else.
#
# The MCP server stays its own OAuth authorization server (Alexa+ add-ons
# need its metadata and dynamic client registration — infra/mcp.tf), but it
# no longer decides who anyone is. Its sign-in pages hand the email and
# password to this pool (services/mcp-server/src/accounts/identity.ts), and
# everything it issues afterwards names the person Cognito vouched for.
#
# Households, memberships and the resident's say in them are Wick's own and
# live in the wick table (services/mcp-server/src/accounts/store.ts). The
# resident has no account here at all: the paired television is their
# identity.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "family" {
  name = "${local.prefix}-family"

  # The email is the username. Case-insensitive, so Sarah@ and sarah@ are
  # one account.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  # Length over composition (NIST SP 800-63B): eight characters or more, and
  # no rule that makes people write the password on a sticky note. The
  # sign-in pages say exactly this.
  password_policy {
    minimum_length                   = 8
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # The name the resident sees on their television when this person asks to
  # join, and on every note they send.
  schema {
    name                = "name"
    attribute_data_type = "String"
    mutable             = true
    required            = true

    string_attribute_constraints {
      min_length = 1
      max_length = 40
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Wick code"
    email_message        = "Your Wick code is {####}. Enter it on the page that asked for it. If you did not ask for this, you can ignore this email."
  }

  # Cognito's own sender: 50 emails a day, no SES setup, enough for a
  # hackathon and its judges. A real launch moves this to SES with a domain.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  lifecycle {
    prevent_destroy = true
    # Cognito cannot change a schema attribute in place; Terraform would
    # otherwise plan to replace the pool, and every account in it.
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "wick" {
  name         = "${local.prefix}-mcp-server"
  user_pool_id = aws_cognito_user_pool.family.id

  # A public client: sign-up, confirmation and sign-in are Cognito's
  # unauthenticated operations, called by the MCP server with this id alone.
  generate_secret = false

  # The server posts the email and password a person typed into its own
  # sign-in page. No SRP in a browser, no hosted UI.
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # "That email and password do not match", whether or not the email exists.
  prevent_user_existence_errors = "ENABLED"

  # Wick issues its own tokens (accounts/oauthProvider.ts); Cognito's are
  # read once, at sign-in, for the person's id, and then dropped.
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}
