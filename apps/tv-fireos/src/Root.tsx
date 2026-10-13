/**
 * What Fire OS puts on the screen: the Vega app, unchanged, and beside it
 * the one thing Android needs that Vega does not — an unseen view for a
 * reading to be played through (adapters/AudioHost.tsx). On Vega an audio
 * player is an object and needs no view; here it is a component, and
 * something has to be mounted for the card to be read aloud.
 */
import * as React from 'react';
import App from '../../tv-vega/src/App';
import { AudioHost } from './adapters/AudioHost';

export function Root(): React.JSX.Element {
  return (
    <>
      <App />
      <AudioHost />
    </>
  );
}
