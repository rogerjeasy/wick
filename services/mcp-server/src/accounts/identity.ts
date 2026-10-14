/**
 * Who a person is: their email and password, kept by Amazon Cognito.
 *
 * Wick never stores a password and never sees one again after handing it to
 * Cognito over TLS. Everything here is one of Cognito's public client
 * operations, so the server needs no IAM permission for them — only the user
 * pool's app client id. Deleting an account is one of them too: the person
 * signs in once more with their password, and the access token Cognito hands
 * back is what deletes their own user (`DeleteUser`). The server is never
 * given the power to delete anybody else's (`AdminDeleteUser`).
 *
 * `send` is a CognitoIdentityProviderClient's send, injected so the exact
 * requests and the mapping of every failure are tested without AWS.
 */
import {
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  DeleteUserCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export interface Identity {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
}

export type IdentityErrorCode =
  | 'email_taken'
  | 'weak_password'
  | 'wrong_credentials'
  | 'not_confirmed'
  | 'bad_code'
  | 'expired_code'
  | 'too_many_attempts'
  | 'unavailable';

/** The only failure this module lets out. Its code is safe to turn into words for a person. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode) {
    super(code);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export interface IdentityProvider {
  /** Sends a confirmation code to the email. */
  signUp(input: { email: string; password: string; name: string }): Promise<void>;
  confirmSignUp(input: { email: string; code: string }): Promise<void>;
  resendCode(input: { email: string }): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<Identity>;
  /** Sends a reset code to the email. */
  forgotPassword(input: { email: string }): Promise<void>;
  resetPassword(input: { email: string; code: string; password: string }): Promise<void>;
  /**
   * Deletes the person's own user, once their password has been given again.
   * `wrong_credentials` when it is not theirs — and when there is no such user
   * any more, which is the same answer sign-in gives.
   */
  deleteAccount(input: { email: string; password: string }): Promise<void>;
}

export type CognitoSend = (command: { readonly input: object }) => Promise<{
  AuthenticationResult?: { IdToken?: string | undefined; AccessToken?: string | undefined } | undefined;
}>;

const ERROR_CODES: Readonly<Record<string, IdentityErrorCode>> = {
  UsernameExistsException: 'email_taken',
  InvalidPasswordException: 'weak_password',
  // One answer for both, so the page never says which emails have accounts.
  NotAuthorizedException: 'wrong_credentials',
  UserNotFoundException: 'wrong_credentials',
  UserNotConfirmedException: 'not_confirmed',
  CodeMismatchException: 'bad_code',
  ExpiredCodeException: 'expired_code',
  LimitExceededException: 'too_many_attempts',
  TooManyRequestsException: 'too_many_attempts',
  TooManyFailedAttemptsException: 'too_many_attempts',
};

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * The claims of a token Cognito has just handed back over TLS in answer to
 * our own request. Its signature is not checked here because it was never
 * out of Cognito's hands: this is not a token a caller presented.
 */
function claimsOf(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new IdentityError('unavailable');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function createCognitoIdentity(send: CognitoSend, clientId: string): IdentityProvider {
  const call = async (command: { readonly input: object }) => {
    try {
      return await send(command);
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      const code = ERROR_CODES[name];
      // Never the provider's own message: it can name the pool or the account.
      if (!code) console.error('[wick/accounts] identity provider failed:', name);
      throw new IdentityError(code ?? 'unavailable');
    }
  };

  return {
    async signUp({ email, password, name }) {
      const username = normaliseEmail(email);
      await call(new SignUpCommand({
        ClientId: clientId,
        Username: username,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'name', Value: name.trim() },
        ],
      }));
    },

    async confirmSignUp({ email, code }) {
      await call(new ConfirmSignUpCommand({ ClientId: clientId, Username: normaliseEmail(email), ConfirmationCode: code.trim() }));
    },

    async resendCode({ email }) {
      await call(new ResendConfirmationCodeCommand({ ClientId: clientId, Username: normaliseEmail(email) }));
    },

    async signIn({ email, password }) {
      const username = normaliseEmail(email);
      const res = await call(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }));
      const idToken = res.AuthenticationResult?.IdToken;
      // A challenge instead of a token (a forced password change, say) is not a sign-in.
      if (!idToken) throw new IdentityError('unavailable');
      const claims = claimsOf(idToken);
      if (typeof claims.sub !== 'string') throw new IdentityError('unavailable');
      return {
        userId: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : username,
        name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : username,
      };
    },

    async forgotPassword({ email }) {
      await call(new ForgotPasswordCommand({ ClientId: clientId, Username: normaliseEmail(email) }));
    },

    async resetPassword({ email, code, password }) {
      await call(new ConfirmForgotPasswordCommand({
        ClientId: clientId,
        Username: normaliseEmail(email),
        ConfirmationCode: code.trim(),
        Password: password,
      }));
    },

    async deleteAccount({ email, password }) {
      const res = await call(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: normaliseEmail(email), PASSWORD: password },
      }));
      const accessToken = res.AuthenticationResult?.AccessToken;
      if (!accessToken) throw new IdentityError('unavailable');
      // The person's own token, just handed back for their own password: it deletes that user and nobody else.
      await call(new DeleteUserCommand({ AccessToken: accessToken }));
    },
  };
}
