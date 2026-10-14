/**
 * Every media command refused (Vega Media Controls). What the platform's
 * handler is when there is no film of hers to obey: on a family member's
 * own television, where the seat beside her film has no pause and no skip
 * (family/FamilySeat.tsx), and on hers between films
 * (watch/mediaControls.ts). Pure, and apart from the resident's watch
 * screen, so a family television can use it without reaching any of hers
 * (family/__tests__/apart.test.ts).
 */
/** Why a command is refused: the platform is told, and nothing happens to any film. */
export class Refused extends Error {
  constructor() {
    super('media_command_refused');
    this.name = 'Refused';
  }
}

/** Every command the platform's handler can be asked, by the names it calls. Built from them, so none is forgotten. */
export const REFUSED_COMMANDS = [
  'handlePlay',
  'handlePause',
  'handleTogglePlayPause',
  'handleStop',
  'handleStartOver',
  'handleFastForward',
  'handleRewind',
  'handleSetPlaybackSpeed',
  'handleSkipForward',
  'handleSkipBackward',
  'handleSeek',
  'handleSetAudioVolume',
  'handleSetAudioTrack',
  'handleEnableTextTrack',
  'handleDisableTextTrack',
  'handleNext',
  'handlePrevious',
  'handleEnableShuffle',
  'handleSetRepeatMode',
  'handleSetRating',
  'handleGetMetadataInfo',
  'handleCustomAction',
] as const;

export type RefusingHandler<S> = { readonly [K in (typeof REFUSED_COMMANDS)[number]]: (...args: unknown[]) => Promise<never> } & {
  readonly handleGetSessionState: (...args: unknown[]) => Promise<readonly S[]>;
};

/**
 * `noFilm` is what the platform is told when it asks: a session that is not
 * playing and offers nothing. (It refuses an empty list — "Array of
 * MediaSessionState is empty" — so "no film" has to be said as a state.)
 */
export function refusesEverything<S = never>(noFilm: readonly S[] = []): RefusingHandler<S> {
  const handler: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of REFUSED_COMMANDS) handler[name] = () => Promise.reject(new Refused());
  handler.handleGetSessionState = () => Promise.resolve(noFilm);
  return handler as RefusingHandler<S>;
}
