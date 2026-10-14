/**
 * Wick on Fire OS. The app is the Vega app: this registers it, with the one
 * unseen view Android needs beside it (src/Root.tsx), and metro.config.js
 * gives it Android in place of the three Amazon packages it was written
 * against.
 */
// First: puts Android's SecureRandom behind crypto.getRandomValues, which is
// where the television's secret comes from (apps/tv-vega/src/random.ts).
// Without it no secret is made, and the television is answered from its id
// alone (AGENTS.md INV-1).
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import { Root } from './src/Root';

AppRegistry.registerComponent('Wick', () => Root);
