// SPDX-License-Identifier: Apache-2.0
// DynamoDB store twins. Skipped unless OVERHEAR_LIVE_TESTS=1 with DynamoDB Local reachable.
// Point OVERHEAR_DYNAMO_ENDPOINT at the local endpoint (default http://127.0.0.1:8000).

import { afterAll, describe, expect, test } from "vitest";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { runStoreConformance } from "../conformance.js";
import { randomBase62 } from "../internal/ids.js";
import { DynamoEventStore } from "./eventStore.js";
import { DynamoTaskStore } from "./taskStore.js";
import { DynamoTaskMessageQueue } from "./messageQueue.js";

const LIVE = process.env["OVERHEAR_LIVE_TESTS"] === "1";
const endpoint = process.env["OVERHEAR_DYNAMO_ENDPOINT"] ?? "http://127.0.0.1:8000";

describe.skipIf(!LIVE)("DynamoDB stores pass the conformance suite (live)", () => {
  const client = new DynamoDBClient({
    endpoint,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const created: string[] = [];

  async function freshTable(): Promise<string> {
    const name = `dur_${randomBase62(12)}`;
    await client.send(
      new CreateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    created.push(name);
    return name;
  }

  afterAll(async () => {
    for (const name of created) {
      await client.send(new DeleteTableCommand({ TableName: name })).catch(() => undefined);
    }
    client.destroy();
  });

  test("full suite against DynamoDB Local", async () => {
    const report = await runStoreConformance(async () => {
      const [eventTable, taskTable, queueTable] = await Promise.all([
        freshTable(),
        freshTable(),
        freshTable(),
      ]);
      return {
        event: new DynamoEventStore({ client: doc, tableName: eventTable }),
        task: new DynamoTaskStore({ client: doc, tableName: taskTable }),
        queue: new DynamoTaskMessageQueue({ client: doc, tableName: queueTable }),
      };
    });
    const failures = report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.error ?? ""}`);
    expect(failures.join("\n")).toBe("");
    expect(report.ok).toBe(true);
  });
});
