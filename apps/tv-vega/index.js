// Copyright (c) 2026 Roger Bavibidila. MIT.
// Interactive component entry point — com.wick.tv.main
//
// Registered under app.json's name, which is the manifest's interactive
// component id (com.wick.tv.main) — registering under any other string
// means the platform's launcher can never find this component. Imported
// from 'react-native' (not '@amazon-devices/react-native-kepler') to match
// the pattern the Vega CLI's own `vega project generate --template
// helloWorld` scaffold uses — verified 2026-09-19 against a real generated
// reference project, Vega CLI 1.3.4 / SDK 0.24.12044.
import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
