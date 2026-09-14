// Copyright (c) 2026 Roger Bavibidila. MIT.
//
// Headless TASK registrations.
// Tasks use registerHeadlessEntryPoint; services use registerHeadlessEntryPoint2.
// Verified against AmazonAppDev/vega-video-sample/task.js (2026-09-14).
import { HeadlessEntryPointRegistry } from '@amazon-devices/headless-task-manager';

import { default as doRhythmSync } from './src/headless/RhythmSyncTask';
import { default as doOnInstall } from './src/headless/OnInstallTask';

HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.rhythmSyncTask::doTask',
  () => doRhythmSync,
);

HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.onInstallTask::doTask',
  () => doOnInstall,
);
