import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * WickCore — the memory plane.
 *
 * INV-3 IS ENFORCED HERE, NOT IN APPLICATION CODE: the snapshots/ prefix carries a
 * one-day expiry lifecycle rule. Storage enforces the promise. That is the
 * difference between a claim and a guarantee, and it is why this must not move
 * into the app.
 *
 * See docs/WICK-TECHNICAL.md §8.
 */
export class WickCoreStack extends Stack {
  readonly table: dynamodb.Table;
  readonly bus: events.EventBus;
  readonly media: s3.Bucket;
  readonly ringSecret: secretsmanager.Secret;
  readonly ringTokenSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Single table. Access patterns are narrow and known (§8.1).
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'wick',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    this.bus = new events.EventBus(this, 'Bus', { eventBusName: 'wick' });

    this.media = new s3.Bucket(this, 'Media', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        // INV-3 — door imagery is discarded within 24 hours, by policy.
        { id: 'snapshots-24h', prefix: 'snapshots/', expiration: Duration.days(1) },
        { id: 'voice-30d', prefix: 'voice/', expiration: Duration.days(30) },
        { id: 'tts-30d', prefix: 'tts/', expiration: Duration.days(30) },
      ],
    });

    // Ring app credentials from the developer console. Populated out of band —
    // never in code, never in the repo.
    this.ringSecret = new secretsmanager.Secret(this, 'RingCredentials', {
      secretName: 'wick/ring/credentials',
      description: 'Ring client id, client secret and HMAC signature key',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Tokens obtained at account linking. Written by the token-exchange Lambda.
    this.ringTokenSecret = new secretsmanager.Secret(this, 'RingTokens', {
      secretName: 'wick/ring/tokens',
      description: 'Ring OAuth access and refresh tokens',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'BusName', { value: this.bus.eventBusName });
    new CfnOutput(this, 'MediaBucket', { value: this.media.bucketName });
    new CfnOutput(this, 'RingSecretName', { value: this.ringSecret.secretName });
  }
}
