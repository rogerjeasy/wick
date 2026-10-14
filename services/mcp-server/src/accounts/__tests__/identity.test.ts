import { describe, expect, it } from 'vitest';
import {
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  DeleteUserCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createCognitoIdentity, IdentityError, type CognitoSend } from '../identity.js';

const CLIENT_ID = 'client-123';

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

function cognito(reply: unknown) {
  const sent: { input: Record<string, unknown> }[] = [];
  const send = (async (command: { input: Record<string, unknown> }) => {
    sent.push(command);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as CognitoSend;
  return { sent, identity: createCognitoIdentity(send, CLIENT_ID) };
}

const awsError = (name: string) => Object.assign(new Error(name), { name });

describe('signing up', () => {
  it('registers the email as the username, with the name the television will show', async () => {
    const { sent, identity } = cognito({});

    await identity.signUp({ email: 'Sarah@Example.com ', password: 'correct horse battery', name: 'Sarah' });

    expect(sent[0]).toBeInstanceOf(SignUpCommand);
    expect(sent[0]!.input).toMatchObject({
      ClientId: CLIENT_ID,
      Username: 'sarah@example.com',
      Password: 'correct horse battery',
      UserAttributes: [
        { Name: 'email', Value: 'sarah@example.com' },
        { Name: 'name', Value: 'Sarah' },
      ],
    });
  });

  it('says the email is taken, rather than leaking a provider error', async () => {
    const { identity } = cognito(awsError('UsernameExistsException'));

    await expect(identity.signUp({ email: 'a@b.co', password: 'x', name: 'A' })).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('says the password is too weak', async () => {
    const { identity } = cognito(awsError('InvalidPasswordException'));

    await expect(identity.signUp({ email: 'a@b.co', password: 'x', name: 'A' })).rejects.toMatchObject({ code: 'weak_password' });
  });

  it('confirms the emailed code', async () => {
    const { sent, identity } = cognito({});

    await identity.confirmSignUp({ email: 'a@b.co', code: ' 123456 ' });

    expect(sent[0]).toBeInstanceOf(ConfirmSignUpCommand);
    expect(sent[0]!.input).toMatchObject({ ClientId: CLIENT_ID, Username: 'a@b.co', ConfirmationCode: '123456' });
  });

  it('says a wrong code is wrong', async () => {
    const { identity } = cognito(awsError('CodeMismatchException'));

    await expect(identity.confirmSignUp({ email: 'a@b.co', code: '000000' })).rejects.toMatchObject({ code: 'bad_code' });
  });
});

describe('signing in', () => {
  it('returns who the person is, from the identity token', async () => {
    const { sent, identity } = cognito({
      AuthenticationResult: { IdToken: idToken({ sub: 'u-123', email: 'sarah@example.com', name: 'Sarah' }) },
    });

    const who = await identity.signIn({ email: 'sarah@example.com', password: 'pw' });

    expect(who).toEqual({ userId: 'u-123', email: 'sarah@example.com', name: 'Sarah' });
    expect(sent[0]).toBeInstanceOf(InitiateAuthCommand);
    expect(sent[0]!.input).toMatchObject({
      ClientId: CLIENT_ID,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'sarah@example.com', PASSWORD: 'pw' },
    });
  });

  it('does not say whether the email or the password was wrong', async () => {
    for (const name of ['NotAuthorizedException', 'UserNotFoundException']) {
      const { identity } = cognito(awsError(name));
      await expect(identity.signIn({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({ code: 'wrong_credentials' });
    }
  });

  it('says when the email has not been confirmed yet', async () => {
    const { identity } = cognito(awsError('UserNotConfirmedException'));

    await expect(identity.signIn({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({ code: 'not_confirmed' });
  });

  it('refuses a sign-in that came back without a token', async () => {
    const { identity } = cognito({ ChallengeName: 'NEW_PASSWORD_REQUIRED' });

    await expect(identity.signIn({ email: 'a@b.co', password: 'x' })).rejects.toBeInstanceOf(IdentityError);
  });
});

describe('a forgotten password', () => {
  it('asks for a reset code', async () => {
    const { sent, identity } = cognito({});

    await identity.forgotPassword({ email: 'a@b.co' });

    expect(sent[0]).toBeInstanceOf(ForgotPasswordCommand);
    expect(sent[0]!.input).toMatchObject({ ClientId: CLIENT_ID, Username: 'a@b.co' });
  });

  it('sets the new password with the code', async () => {
    const { sent, identity } = cognito({});

    await identity.resetPassword({ email: 'a@b.co', code: '123456', password: 'new password 1' });

    expect(sent[0]).toBeInstanceOf(ConfirmForgotPasswordCommand);
    expect(sent[0]!.input).toMatchObject({ Username: 'a@b.co', ConfirmationCode: '123456', Password: 'new password 1' });
  });

  it('says so when too many attempts were made', async () => {
    const { identity } = cognito(awsError('LimitExceededException'));

    await expect(identity.forgotPassword({ email: 'a@b.co' })).rejects.toMatchObject({ code: 'too_many_attempts' });
  });
});

describe('deleting an account', () => {
  it('signs in with the password once more, and deletes that user with its own access token — never as an administrator', async () => {
    const { sent, identity } = cognito({ AuthenticationResult: { IdToken: idToken({ sub: 'u1' }), AccessToken: 'the-persons-own-token' } });

    await identity.deleteAccount({ email: ' Sarah@Example.com', password: 'correct horse battery' });

    expect(sent[0]).toBeInstanceOf(InitiateAuthCommand);
    expect(sent[0]!.input).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: 'sarah@example.com', PASSWORD: 'correct horse battery' } });
    expect(sent[1]).toBeInstanceOf(DeleteUserCommand);
    expect(sent[1]!.input).toEqual({ AccessToken: 'the-persons-own-token' });
    expect(sent).toHaveLength(2);
  });

  it('deletes nothing for a wrong password, and says so as sign-in would', async () => {
    const { sent, identity } = cognito(awsError('NotAuthorizedException'));

    await expect(identity.deleteAccount({ email: 'sarah@example.com', password: 'wrong' })).rejects.toMatchObject({ code: 'wrong_credentials' });
    expect(sent).toHaveLength(1);
  });

  it('deletes nothing when Cognito hands back a challenge instead of a token', async () => {
    const { sent, identity } = cognito({ AuthenticationResult: undefined });

    await expect(identity.deleteAccount({ email: 'sarah@example.com', password: 'pw' })).rejects.toBeInstanceOf(IdentityError);
    expect(sent).toHaveLength(1);
  });
});
