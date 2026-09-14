// Copyright (c) 2026 Roger Bavibidila. MIT.
//
// Headless SERVICE registrations.
// Verified against AmazonAppDev/vega-video-sample/service.js (2026-09-14).
import { HeadlessEntryPointRegistry } from '@amazon-devices/headless-task-manager';

import { onStartCardService, onStopCardService } from './src/headless/CardService';
import { onStartDataRefresh, onStopDataRefresh } from './src/headless/DataRefreshService';

HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStartService',
  () => onStartCardService,
);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStopService',
  () => onStopCardService,
);

HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStartService',
  () => onStartDataRefresh,
);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStopService',
  () => onStopDataRefresh,
);
