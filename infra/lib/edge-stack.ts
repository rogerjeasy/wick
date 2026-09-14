import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no module-level directory global; the repo is "type": "module".
const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface WickEdgeProps extends StackProps {
  table: dynamodb.Table;
  bus: events.EventBus;
  ringSecret: secretsmanager.Secret;
  ringTokenSecret: secretsmanager.Secret;
}

/**
 * WickEdge — terminates Ring.
 *
 * The webhook receiver must acknowledge inside Ring's five-second budget, so it
 * gets a tight timeout and reserved concurrency: a downstream problem must never
 * be able to delay the ACK. See docs/WICK-TECHNICAL.md §7.1, §9.1.
 */
export class WickEdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: WickEdgeProps) {
    super(scope, id, props);

    const LAMBDA_DIR = path.join(HERE, '../../services/edge-ring/lambda');

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(LAMBDA_DIR),
      logRetention: logs.RetentionDays.TWO_WEEKS,
      memorySize: 256,
    };

    const webhook = new lambda.Function(this, 'RingWebhook', {
      ...common,
      handler: 'webhook.handler',
      timeout: Duration.seconds(5),          // Ring's own budget. Never raise this.
      // Reserved concurrency deliberately unset. The intent was to stop a
      // downstream problem starving the ACK path — but this account's total
      // Lambda concurrency quota is 10 (new-account default; mature accounts get
      // 1000), so any reservation drops unreserved below the service minimum.
      // Restore `reservedConcurrentExecutions: 20` once the quota is raised.
      environment: {
        TABLE_NAME: props.table.tableName,
        BUS_NAME: props.bus.eventBusName,
        RING_SECRET_ARN: props.ringSecret.secretArn,
      },
    });
    props.table.grantWriteData(webhook);
    props.bus.grantPutEventsTo(webhook);
    props.ringSecret.grantRead(webhook);

    const token = new lambda.Function(this, 'RingTokenExchange', {
      ...common,
      handler: 'token.handler',
      timeout: Duration.seconds(15),
      environment: {
        RING_SECRET_ARN: props.ringSecret.secretArn,
        RING_TOKEN_SECRET_ARN: props.ringTokenSecret.secretArn,
      },
    });
    props.ringSecret.grantRead(token);
    props.ringTokenSecret.grantRead(token);
    props.ringTokenSecret.grantWrite(token);

    const link = new lambda.Function(this, 'RingAccountLink', {
      ...common,
      handler: 'link.handler',
      timeout: Duration.seconds(5),
    });

    const api = new apigw.HttpApi(this, 'Api', {
      apiName: 'wick-edge',
      description: 'Ring account linking and event ingress',
    });

    api.addRoutes({
      path: '/ring/webhook',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookInt', webhook),
    });
    api.addRoutes({
      path: '/ring/token',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('TokenInt', token),
    });
    api.addRoutes({
      path: '/ring/link',
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration('LinkInt', link),
    });

    const base = api.apiEndpoint;
    new CfnOutput(this, 'AccountLinkUrl', { value: `${base}/ring/link` });
    new CfnOutput(this, 'TokenExchangeUrl', { value: `${base}/ring/token` });
    new CfnOutput(this, 'WebhookUrl', { value: `${base}/ring/webhook` });
  }
}
