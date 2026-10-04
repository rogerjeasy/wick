/**
 * Which household a television belongs to: `DEV#<deviceId>` / `META`.
 *
 * Two reasons this exists beside the `HH#<household>` / `DEV#<deviceId>`
 * binding:
 *
 *   - INV-8. pair-refresh.mjs used to take the household from the request
 *     body. Now it looks it up here, from the device id alone.
 *   - A television belongs to one household. The claim is conditional, so
 *     connecting a television in one home can never take over a television
 *     that is already another home's — that home would start receiving the
 *     new household's cards on its next refresh. It has to be disconnected
 *     there first.
 *
 * Pure: the pairing Lambdas own the DynamoDB client.
 */

export function deviceOwnerKey(deviceId) {
  return { pk: { S: `DEV#${deviceId}` }, sk: { S: 'META' } };
}

/** PutItem input. Fails its condition when another household holds the television. */
export function claimDeviceOwner({ table, deviceId, householdId, at }) {
  return {
    TableName: table,
    Item: { ...deviceOwnerKey(deviceId), householdId: { S: householdId }, claimedAt: { N: String(at) } },
    ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
    ExpressionAttributeValues: { ':hh': { S: householdId } },
  };
}

export function householdOfDevice(item) {
  return item?.householdId?.S || undefined;
}
