// Поддельный клиент MQTT администратора Dynamic Security: отвечает на команды как плагин
// (без брокера). Для createDynsec в тестах: состояние в roles и clients, порядок команд в log.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CONTROL_TOPIC, RESPONSE_TOPIC } from '../lib/dynsec.mjs';

export class FakeDynsecBroker extends EventEmitter {
  constructor() {
    super();
    this.roles = new Map();
    this.clients = new Map();
    this.log = [];
  }

  async subscribeAsync(topic) {
    assert.equal(topic, RESPONSE_TOPIC);
  }

  publish(topic, payload, _opts, cb) {
    assert.equal(topic, CONTROL_TOPIC);
    const responses = JSON.parse(payload).commands.map((c) => ({ command: c.command, correlationData: c.correlationData, ...this.exec(c) }));
    cb?.();
    setImmediate(() => this.emit('message', RESPONSE_TOPIC, Buffer.from(JSON.stringify({ responses }))));
  }

  exec(c) {
    this.log.push(c.command);
    switch (c.command) {
      case 'getRole':
        return this.roles.has(c.rolename) ? { data: { role: { rolename: c.rolename, acls: this.roles.get(c.rolename) } } } : { error: 'Role not found' };
      case 'createRole':
        if (this.roles.has(c.rolename)) return { error: 'Role already exists' };
        this.roles.set(c.rolename, [...c.acls]);
        return {};
      case 'removeRoleACL': {
        const acls = this.roles.get(c.rolename);
        const i = acls.findIndex((a) => a.acltype === c.acltype && a.topic === c.topic);
        if (i < 0) return { error: 'ACL not found' };
        acls.splice(i, 1);
        return {};
      }
      case 'addRoleACL': {
        const { command: _c, correlationData: _d, rolename, ...acl } = c;
        this.roles.get(rolename).push(acl);
        return {};
      }
      case 'getClient':
        return this.clients.has(c.username) ? { data: { client: this.clients.get(c.username) } } : { error: 'Client not found' };
      case 'createClient':
        this.clients.set(c.username, { password: c.password, clientid: c.clientid, roles: c.roles, disabled: false });
        return {};
      case 'modifyClient':
        Object.assign(this.clients.get(c.username), { clientid: c.clientid, roles: c.roles });
        return {};
      case 'setClientPassword':
        this.clients.get(c.username).password = c.password;
        return {};
      case 'enableClient':
        this.clients.get(c.username).disabled = false;
        return {};
      default:
        return { error: 'Unknown command' };
    }
  }
}
