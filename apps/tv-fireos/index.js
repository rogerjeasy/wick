/**
 * Wick on Fire OS. The app is the Vega app: this registers its root
 * component, and metro.config.js gives it Android in place of the three
 * Amazon packages it was written against.
 */
import { AppRegistry } from 'react-native';
import App from '../tv-vega/src/App';

AppRegistry.registerComponent('Wick', () => App);
