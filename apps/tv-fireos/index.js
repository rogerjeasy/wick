/**
 * Wick on Fire OS. The app is the Vega app: this registers it, with the one
 * unseen view Android needs beside it (src/Root.tsx), and metro.config.js
 * gives it Android in place of the three Amazon packages it was written
 * against.
 */
import { AppRegistry } from 'react-native';
import { Root } from './src/Root';

AppRegistry.registerComponent('Wick', () => Root);
