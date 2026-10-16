/**
 * Wick on Fire OS. The app is the Vega app: this registers it, with the one
 * unseen view Android needs beside it (src/Root.tsx), and the task the door
 * service runs behind another app (src/door/task.ts). metro.config.js
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
import { DOOR_TASK, doorTask } from './src/door/task';

AppRegistry.registerComponent('Wick', () => Root);
// The door, outside Wick: what the Android door service runs behind another app (src/door/doorService.ts).
AppRegistry.registerHeadlessTask(DOOR_TASK, () => doorTask);
