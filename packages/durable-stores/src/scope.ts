// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Resolves a transport session to a durable scope.

/**
 * Resolves a transport session id to a durable scope (a principal). Every task
 * and queue method is partitioned by the resolved scope, so two principals never
 * see each other's tasks even when the transport session id changes.
 */
export type Scope = (sessionId: string | undefined) => Promise<string>;

/**
 * The scope used when no session id is present. All session-less calls share it,
 * which matches the SDK stores treating such tasks as global.
 */
export const GLOBAL_SCOPE = "";

/**
 * Default scope: the session id is the scope. This matches the SDK behaviour of
 * keying by the transport session id. A server that wants to bind tasks to the
 * authenticated principal passes its own resolver instead.
 */
export const identityScope: Scope = async (sessionId) => sessionId ?? GLOBAL_SCOPE;
