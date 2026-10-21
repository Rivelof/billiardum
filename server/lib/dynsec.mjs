// Клиент плагина Mosquitto Dynamic Security (decisions №15): команды JSON в
// $CONTROL/dynamic-security/v1, ответы в …/response, сопоставление по correlationData.

import { randomUUID } from 'node:crypto';
import { deviceTopic } from './protocol.mjs';

export const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
export const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;

export class DynsecError extends Error {
  constructor(command, error) {
    super(`dynsec ${command}: ${error}`);
    this.name = 'DynsecError';
    this.command = command;
    this.error = error;
  }
}

/** Роль устройства: точные топики протокола §2 — чтение cmd, запись ack/state/event/status. */
export function deviceRoleAcls(clubId, deviceId) {
  const t = (kind) => deviceTopic(clubId, deviceId, kind);
  return [
    { acltype: 'subscribeLiteral', topic: t('cmd'), priority: 0, allow: true },
    { acltype: 'publishClientReceive', topic: t('cmd'), priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: t('ack'), priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: t('state'), priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: t('event'), priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: t('status'), priority: 0, allow: true },
  ];
}

/** Роль сервера: все топики протокола bl/v1/#. Управление Dynamic Security — у bl-admin. */
export function serverRoleAcls() {
  return [
    { acltype: 'subscribePattern', topic: 'bl/v1/#', priority: 0, allow: true },
    { acltype: 'publishClientReceive', topic: 'bl/v1/#', priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: 'bl/v1/#', priority: 0, allow: true },
  ];
}

export function deviceRoleName(deviceId) {
  return `bl-device-${deviceId}`;
}

/**
 * @param {import('mqtt').MqttClient} client — подключён администратором Dynamic Security.
 */
export async function createDynsec(client, { timeoutMs = 10_000 } = {}) {
  const waiting = new Map();
  client.on('message', (topic, payload) => {
    if (topic !== RESPONSE_TOPIC) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    for (const r of msg.responses ?? []) {
      const w = waiting.get(r.correlationData);
      if (!w) continue;
      waiting.delete(r.correlationData);
      clearTimeout(w.timer);
      w.resolve(r);
    }
  });
  await client.subscribeAsync(RESPONSE_TOPIC, { qos: 1 });

  /** Одна команда; ошибка плагина — DynsecError (если не в списке allowErrors). */
  async function run(command, { allowErrors = [] } = {}) {
    const correlationData = randomUUID();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(correlationData);
        reject(new DynsecError(command.command, 'нет ответа брокера'));
      }, timeoutMs);
      waiting.set(correlationData, { resolve, timer });
      client.publish(CONTROL_TOPIC, JSON.stringify({ commands: [{ ...command, correlationData }] }), { qos: 1 }, (err) => {
        if (err) {
          clearTimeout(timer);
          waiting.delete(correlationData);
          reject(err);
        }
      });
    });
    if (response.error && !allowErrors.includes(response.error)) throw new DynsecError(command.command, response.error);
    return response;
  }

  function sameAcl(a, b) {
    return a.acltype === b.acltype && a.topic === b.topic && (a.allow ?? true) === b.allow && (a.priority ?? 0) === b.priority;
  }

  /** Роль с ровно этими ACL: создаёт или приводит существующую к нужному виду. */
  async function ensureRole(rolename, acls, textname) {
    const got = await run({ command: 'getRole', rolename }, { allowErrors: ['Role not found'] });
    if (got.error) {
      await run({ command: 'createRole', rolename, textname, acls });
      return 'created';
    }
    const current = got.data?.role?.acls ?? [];
    for (const acl of current) {
      if (!acls.some((want) => sameAcl(acl, want))) {
        await run({ command: 'removeRoleACL', rolename, acltype: acl.acltype, topic: acl.topic });
      }
    }
    for (const want of acls) {
      if (!current.some((acl) => sameAcl(acl, want))) {
        await run({ command: 'removeRoleACL', rolename, acltype: want.acltype, topic: want.topic }, { allowErrors: ['ACL not found'] });
        await run({ command: 'addRoleACL', rolename, ...want });
      }
    }
    return 'updated';
  }

  /** Клиент с паролем, ролью и (если задан) обязательным client id. */
  async function ensureClient({ username, password, clientid, rolename, textname }) {
    const got = await run({ command: 'getClient', username }, { allowErrors: ['Client not found'] });
    const roles = [{ rolename, priority: -1 }];
    if (got.error) {
      const cmd = { command: 'createClient', username, password, roles, textname };
      if (clientid) cmd.clientid = clientid;
      await run(cmd);
      return 'created';
    }
    const modify = { command: 'modifyClient', username, roles, textname };
    if (clientid) modify.clientid = clientid;
    await run(modify);
    await run({ command: 'setClientPassword', username, password });
    await run({ command: 'enableClient', username });
    return 'updated';
  }

  return { run, ensureRole, ensureClient };
}
