#include "support.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;

namespace test {

const char* const kScenarioKeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
static const int64_t kIssuedAt = 1792598400;

static bool isRepo(const fs::path& p) {
  std::error_code ec;
  return fs::exists(p / "docs" / "protocol-vectors.json", ec) && fs::exists(p / "tools" / "device-sim" / "scenarios", ec);
}

std::string repoRoot() {
  if (const char* env = std::getenv("BL_REPO_ROOT")) {
    if (isRepo(env)) return env;
  }
#ifdef BL_REPO_ROOT
  if (isRepo(BL_REPO_ROOT)) return BL_REPO_ROOT;
#endif
  std::error_code ec;
  for (fs::path p = fs::current_path(ec); !p.empty(); p = p.parent_path()) {
    if (isRepo(p)) return p.string();
    if (p == p.parent_path()) break;
  }
  return ".";
}

std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

bl::Json readJsonFile(const std::string& path) {
  bl::Json j;
  bl::parseJson(readFile(path), j, bl::ParseMode::Relaxed);
  return j;
}

std::vector<std::string> listJson(const std::string& dir) {
  std::vector<std::string> out;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(dir, ec)) {
    if (e.path().extension() == ".json") out.push_back(e.path().filename().string());
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::string decodeB64(const std::string& b64) {
  std::string out;
  bl::base64DecodeStrict(b64, out);
  return out;
}

// ——— Recorder ———

void Recorder::publishState(const std::string& payload, bool changed) {
  order.push_back("state");
  states.push_back(payload);
  stateChanged.push_back(changed);
}

void Recorder::publishAck(const std::string& payload, const std::string&) {
  order.push_back("ack");
  acks.push_back(payload);
}

void Recorder::eventCreated(const bl::EventEntry& e) {
  order.push_back("event");
  bl::Json j;
  bl::parseJson(e.payload, j, bl::ParseMode::Relaxed);
  events.push_back(j);
}

void Recorder::signal(const char* name, int beeps) {
  order.push_back(std::string("signal:") + name);
  if (std::strcmp(name, "warn") == 0) warn += 1;
  if (std::strcmp(name, "blink2") == 0) blink2 += 1;
  if (std::strcmp(name, "grace") == 0) grace += 1;
  if (std::strcmp(name, "grace_blink") == 0) graceBlink += 1;
  beep += beeps;
}

void Recorder::relayOn(const std::string& cmdId, const char* type) {
  order.push_back("relay");
  relayOnCmds.push_back(cmdId + " " + type);
}

void Recorder::otaStart(const bl::Body& b) {
  order.push_back("ota");
  otaVersion = b.version;
}

// ——— Команды ———

std::string commandId(int n) {
  std::string num = bl::intToString(n);
  return "00000000-0000-4000-8000-" + std::string(12 - num.size(), '0') + num;
}

std::string signCommand(const std::string& keyB64, const std::string& id, int64_t seq, const std::string& type, const bl::Json& body) {
  bl::Json cmd = bl::Json::object();
  cmd.set("v", bl::Json::integer(1));
  cmd.set("id", bl::Json::string(id));
  cmd.set("seq", bl::Json::integer(seq));
  cmd.set("type", bl::Json::string(type));
  cmd.set("issued_at", bl::Json::integer(kIssuedAt));
  cmd.set("body", body.isObject() ? body : bl::Json::object());
  std::string canonical = bl::canonicalize(cmd, nullptr);
  std::string key = decodeB64(keyB64);
  uint8_t mac[32];
  bl::hmacSha256Portable((const uint8_t*)key.data(), key.size(), (const uint8_t*)canonical.data(), canonical.size(), mac);
  cmd.set("sig", bl::Json::string(bl::base64Encode(mac, 32)));
  return cmd.dump();
}

// ——— Rig ———

static std::string rigBootId(void* ctx) {
  Rig* r = static_cast<Rig*>(ctx);
  std::string n = bl::intToString(r->boots);
  return "b00000" + std::string(2 - std::min<size_t>(2, n.size()), '0') + n;
}

Rig::Rig(bl::Caps c, bl::Nvs* sharedNvs, const std::string& key) : nvs(sharedNvs ? sharedNvs : &ownNvs), caps(c), keyB64(key) {}

void Rig::boot(int64_t at, const char* reason) {
  now = at;
  boots += 1;
  bl::MachineOptions o;
  std::string key = decodeB64(keyB64);
  std::memcpy(o.key, key.data(), 32);
  o.caps = caps;
  o.fw = "1.0.0-test";
  o.nvs = nvs;
  o.hal = &hal;
  o.out = &rec;
  o.bootId = rigBootId;
  o.bootIdCtx = this;
  machine.reset(new bl::Machine(o));
  machine->start(now, reason);
}

bl::Json Rig::send(const std::string& type, const bl::Json& body, int64_t s, const std::string& key) {
  cmds += 1;
  if (s < 0) s = seq + 1;
  seq = std::max(seq, s);
  return sendRaw(signCommand(key.empty() ? keyB64 : key, commandId(cmds), s, type, body));
}

bl::Json Rig::sendRaw(const std::string& raw) {
  size_t before = rec.acks.size();
  machine->handleCommand(now, (const uint8_t*)raw.data(), raw.size());
  bl::Json ack;
  if (rec.acks.size() > before) bl::parseJson(rec.acks.back(), ack, bl::ParseMode::Relaxed);
  return ack;
}

void Rig::advance(int64_t ms) {
  now += ms;
  machine->tick(now);
}

// ——— Сравнение ———

bool jsonEqual(const bl::Json& a, const bl::Json& b) {
  if (a.type() != b.type()) return false;
  switch (a.type()) {
    case bl::Json::Type::Null: return true;
    case bl::Json::Type::Bool: return a.asBool() == b.asBool();
    case bl::Json::Type::Int: return a.asInt() == b.asInt();
    case bl::Json::Type::String: return a.asString() == b.asString();
    case bl::Json::Type::Array:
      if (a.items().size() != b.items().size()) return false;
      for (size_t i = 0; i < a.items().size(); ++i) {
        if (!jsonEqual(a.items()[i], b.items()[i])) return false;
      }
      return true;
    case bl::Json::Type::Object:
      if (a.members().size() != b.members().size()) return false;
      for (const auto& m : a.members()) {
        const bl::Json* o = b.get(m.first);
        if (!o || !jsonEqual(m.second, *o)) return false;
      }
      return true;
  }
  return false;
}

std::string partialMismatch(const bl::Json& expected, const bl::Json& actual, const std::string& where) {
  if (expected.isObject()) {
    if (!actual.isObject()) return where + ": ждали объект " + expected.dump() + ", есть " + actual.dump();
    for (const auto& m : expected.members()) {
      const bl::Json* a = actual.get(m.first);
      bl::Json missing;  // как undefined в JS: не равно ничему, кроме отсутствия
      std::string r = a ? partialMismatch(m.second, *a, where + "." + m.first) : where + "." + m.first + ": нет поля, ждали " + m.second.dump();
      if (!r.empty()) return r;
    }
    return "";
  }
  if (!jsonEqual(expected, actual)) return where + ": ждали " + expected.dump() + ", есть " + actual.dump();
  return "";
}

// ——— Исполнитель сценариев (повторяет tools/device-sim/lib/scenario.mjs) ———

namespace {

const char* const kStateFields[] = {"mode", "relay", "dim", "led", "buzzer", "remaining_ms", "session_id", "current_ma", "last_seq", "boot"};
const char* const kActions[] = {"cmd", "raw", "resend", "advance_ms", "reboot", "net", "fault", "expect", "events"};

struct Runner {
  std::vector<std::string> failures;
  bl::MemoryNvs nvs;
  bool online = true;
  size_t eventsSeen = 0;
  struct Label {
    std::string raw;
    std::string ack;
  };
  std::vector<std::pair<std::string, Label>> labels;
  std::unique_ptr<Rig> rig;

  void deliver() {
    if (!online) return;
    for (const auto& e : rig->machine->outbox()) rig->machine->eventDelivered(e.bootId, e.n);
  }

  void boot(const char* reason) {
    rig->boot(rig->now, reason);
    rig->machine->setOnline(online);
    deliver();
  }

  std::string feed(const std::string& raw) {
    size_t before = rig->rec.acks.size();
    rig->machine->handleCommand(rig->now, (const uint8_t*)raw.data(), raw.size());
    deliver();
    return rig->rec.acks.size() > before ? rig->rec.acks.back() : std::string();
  }

  void checkAck(size_t i, const std::string& ackRaw, const std::string& expected) {
    if (ackRaw.empty()) {
      failures.push_back("шаг " + bl::intToString((int64_t)i) + ": нет ack");
      return;
    }
    bl::Json ack;
    bl::parseJson(ackRaw, ack, bl::ParseMode::Relaxed);
    std::string got = ack.get("ok")->asBool() ? "ok" : ack.get("error")->asString();
    if (got != expected) failures.push_back("шаг " + bl::intToString((int64_t)i) + ": ack " + got + ", ждали " + expected);
  }

  bl::Json signalsJson() const {
    bl::Json j = bl::Json::object();
    j.set("warn", bl::Json::integer(rig->rec.warn));
    j.set("beep", bl::Json::integer(rig->rec.beep));
    j.set("blink2", bl::Json::integer(rig->rec.blink2));
    j.set("grace", bl::Json::integer(rig->rec.grace));
    j.set("grace_blink", bl::Json::integer(rig->rec.graceBlink));
    return j;
  }

  bl::Json nvsSession() {
    std::string s;
    bl::Json j;
    if (!nvs.get(bl::nvs_keys::kSession, s)) return bl::Json::null();
    bl::parseJson(s, j, bl::ParseMode::Relaxed);
    return j;
  }

  bl::Json outboxTypes() {
    bl::Json a = bl::Json::array();
    for (const auto& e : rig->machine->outbox()) a.push(bl::Json::string(e.type));
    return a;
  }

  void run(const bl::Json& scenario) {
    const bl::Json* key = scenario.get("key_b64");
    bl::Caps caps;  // по умолчанию relay, led, buzzer, current
    if (const bl::Json* c = scenario.get("caps")) {
      caps = bl::Caps{false, false, false, false, false};
      for (const auto& x : c->items()) {
        const std::string& n = x.asString();
        if (n == "relay") caps.relay = true;
        if (n == "led") caps.led = true;
        if (n == "buzzer") caps.buzzer = true;
        if (n == "current") caps.current = true;
        if (n == "dimmer") caps.dimmer = true;
      }
    }
    if (const bl::Json* o = scenario.get("online")) online = o->asBool();
    rig.reset(new Rig(caps, &nvs, key ? key->asString() : kScenarioKeyB64));
    boot("poweron");

    const bl::Json* steps = scenario.get("steps");
    for (size_t idx = 0; steps && idx < steps->items().size(); ++idx) {
      const bl::Json& step = steps->items()[idx];
      size_t i = idx + 1;
      std::string where = "шаг " + bl::intToString((int64_t)i);
      std::vector<std::string> acts;
      for (const char* a : kActions) {
        if (step.has(a)) acts.push_back(a);
      }
      if (acts.size() != 1) {
        failures.push_back(where + ": нужно ровно одно действие");
        continue;
      }
      const std::string& act = acts[0];
      if (act == "cmd") {
        rig->cmds += 1;
        const bl::Json* s = step.get("seq");
        int64_t seq = s ? s->asInt() : rig->seq + 1;
        rig->seq = std::max(rig->seq, seq);
        const bl::Json* id = step.get("id");
        const bl::Json* body = step.get("body");
        const bl::Json* k = step.get("key");
        std::string keyB64 = rig->keyB64;
        if (k && k->asString() == "other") keyB64 = bl::base64Encode((const uint8_t*)std::string(32, '\x07').data(), 32);
        std::string raw = signCommand(keyB64, id ? id->asString() : commandId(rig->cmds), seq, step.get("cmd")->asString(),
                                      body ? *body : bl::Json::object());
        std::string ack = feed(raw);
        const bl::Json* want = step.get("ack");
        checkAck(i, ack, want ? want->asString() : "ok");
        if (const bl::Json* label = step.get("label")) labels.push_back({label->asString(), Label{raw, ack}});
      } else if (act == "raw") {
        std::string ack = feed(step.get("raw")->asString());
        const bl::Json* want = step.get("ack");
        checkAck(i, ack, want ? want->asString() : "bad_format");
      } else if (act == "resend") {
        const Label* prev = nullptr;
        for (const auto& l : labels) {
          if (l.first == step.get("resend")->asString()) prev = &l.second;
        }
        if (!prev) {
          failures.push_back(where + ": нет метки");
          continue;
        }
        std::string ack = feed(prev->raw);
        const bl::Json* same = step.get("ack_same");
        if (same && same->asBool() && ack != prev->ack) failures.push_back(where + ": ack повтора " + ack + " ≠ " + prev->ack);
        if (const bl::Json* want = step.get("ack")) checkAck(i, ack, want->asString());
      } else if (act == "advance_ms") {
        rig->advance(step.get("advance_ms")->asInt());
        deliver();
      } else if (act == "reboot") {
        const bl::Json* opts = step.get("reboot");
        std::string reason = "poweron";
        if (opts->isObject()) {
          if (const bl::Json* d = opts->get("down_ms")) rig->now += d->asInt();
          if (const bl::Json* r = opts->get("reset_reason")) reason = r->asString();
        }
        boot(reason.c_str());
      } else if (act == "net") {
        online = step.get("net")->asBool();
        rig->machine->setOnline(online);
        deliver();
      } else if (act == "fault") {
        const std::string& name = step.get("fault")->asString();
        bool on = step.get("on")->asBool();
        if (name == "bypass") {
          rig->hal.bypass = on;
        } else if (name == "lamp-fault") {
          rig->hal.lampFault = on;
        } else {
          failures.push_back(where + ": неизвестный сбой " + name);
        }
        rig->machine->sensorChanged(rig->now);
        deliver();
      } else if (act == "expect") {
        const bl::Json& want = *step.get("expect");
        bl::Json snap = rig->machine->snapshot(rig->now);
        for (const auto& m : want.members()) {
          bool known = false;
          for (const char* f : kStateFields) {
            if (m.first == f) {
              known = true;
              const bl::Json* a = snap.get(f);
              std::string r = partialMismatch(m.second, a ? *a : bl::Json::null(), f);
              if (!r.empty()) failures.push_back(where + ": " + r);
            }
          }
          if (known) continue;
          bl::Json actual;
          if (m.first == "lamp") {
            actual = bl::Json::boolean(rig->machine->lamp());
          } else if (m.first == "signals") {
            actual = signalsJson();
          } else if (m.first == "nvs_session") {
            actual = nvsSession();
          } else if (m.first == "outbox") {
            actual = outboxTypes();
          } else if (m.first == "config") {
            actual = rig->machine->config().toJson();
          } else {
            failures.push_back(where + ": неизвестное поле expect " + m.first);
            continue;
          }
          std::string r = partialMismatch(m.second, actual, m.first);
          if (!r.empty()) failures.push_back(where + ": " + r);
        }
      } else if (act == "events") {
        const auto& want = step.get("events")->items();
        std::vector<bl::Json> got(rig->rec.events.begin() + (std::ptrdiff_t)eventsSeen, rig->rec.events.end());
        eventsSeen = rig->rec.events.size();
        if (want.size() != got.size()) {
          std::string g, w;
          for (const auto& e : got) g += e.get("type")->asString() + " ";
          for (const auto& e : want) w += (e.isString() ? e.asString() : e.get("type")->asString()) + " ";
          failures.push_back(where + ": события [" + g + "], ждали [" + w + "]");
          continue;
        }
        for (size_t k = 0; k < want.size(); ++k) {
          bl::Json w = want[k];
          if (w.isString()) {
            bl::Json o = bl::Json::object();
            o.set("type", w);
            w = o;
          }
          std::string r = partialMismatch(w, got[k], "events[" + bl::intToString((int64_t)k) + "]");
          if (!r.empty()) failures.push_back(where + ": " + r);
        }
      }
    }
  }
};

}  // namespace

std::vector<std::string> runScenario(const bl::Json& scenario) {
  Runner r;
  r.run(scenario);
  return r.failures;
}

}  // namespace test
