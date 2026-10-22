#include "bl_machine.h"

#include <algorithm>
#include <cstring>

#include "bl_command.h"

namespace bl {

namespace {

const char* const kModeNames[] = {"free", "pending", "reserved", "active", "ending", "grace", "service", "fault"};
const char* const kLedNames[] = {"off", "green_dim", "white_blink", "blue", "yellow_blink", "red", "red_fast", "purple", "identify"};

Led ledFor(Mode m) {
  switch (m) {
    case Mode::Free: return Led::GreenDim;
    case Mode::Pending: return Led::WhiteBlink;
    case Mode::Reserved: return Led::Blue;
    case Mode::Active: return Led::Off;
    case Mode::Ending: return Led::YellowBlink;
    case Mode::Grace: return Led::Red;
    case Mode::Service: return Led::Purple;
    case Mode::Fault: return Led::RedFast;
  }
  return Led::Off;
}

bool isIdle(Mode m) { return m == Mode::Free || m == Mode::Pending || m == Mode::Reserved; }

void track(int64_t& since, bool& latched, bool cond, int64_t now) {
  if (cond) {
    if (since == kNoDeadline) since = now;
  } else {
    since = kNoDeadline;
    latched = false;
  }
}

std::string defaultBootId(void*) { return "00000000"; }

}  // namespace

const char* modeName(Mode m) { return kModeNames[(int)m]; }
const char* ledName(Led l) { return kLedNames[(int)l]; }

Json Caps::toJson() const {
  Json a = Json::array();
  if (relay) a.push(Json::string("relay"));
  if (led) a.push(Json::string("led"));
  if (buzzer) a.push(Json::string("buzzer"));
  if (current) a.push(Json::string("current"));
  if (dimmer) a.push(Json::string("dimmer"));
  return a;
}

Json Config::toJson() const {
  Json j = Json::object();
  j.set("led_brightness", Json::integer(ledBrightness));
  j.set("current_on_ma", Json::integer(currentOnMa));
  j.set("current_confirm_ms", Json::integer(currentConfirmMs));
  j.set("grace_dim", Json::integer(graceDim));
  j.set("grace_blink_s", Json::integer(graceBlinkS));
  return j;
}

void Config::merge(const Json& j) {
  auto pick = [&](const char* k, int64_t& dst) {
    const Json* v = j.get(k);
    if (v && v->isInt()) dst = v->asInt();
  };
  pick("led_brightness", ledBrightness);
  pick("current_on_ma", currentOnMa);
  pick("current_confirm_ms", currentConfirmMs);
  pick("grace_dim", graceDim);
  pick("grace_blink_s", graceBlinkS);
}

Machine::Machine(const MachineOptions& o)
    : caps_(o.caps),
      fw_(o.fw),
      nvs_(*o.nvs),
      hal_(*o.hal),
      out_(o.out),
      hmac_(o.hmac ? o.hmac : hmacSha256Portable),
      bootIdFn_(o.bootId ? o.bootId : defaultBootId),
      bootIdCtx_(o.bootIdCtx),
      ring_(*o.nvs, o.ringCapacity) {
  std::memcpy(key_, o.key, 32);
}

// ——— Загрузка ———

void Machine::start(int64_t now, const char* resetReason) {
  t_ = now;
  std::string s;
  boot_ = 1;
  if (nvs_.get(nvs_keys::kBoot, s)) {
    Json j;
    if (parseJson(s, j, ParseMode::Strict).ok && j.isInt()) boot_ = j.asInt() + 1;
  }
  nvs_.set(nvs_keys::kBoot, intToString(boot_));
  bootId_ = bootIdFn_(bootIdCtx_);
  eventN_ = 0;
  bootAt_ = now;
  ReplayRecord rec;
  if (nvs_.get(nvs_keys::kReplay, s)) rec = ReplayRecord::fromJson(s);
  lastSeq_ = rec.valid ? rec.seq : 0;
  stateSeq_ = 0;
  hasLastKey_ = false;
  online_ = false;
  rejectAt_[0] = rejectAt_[1] = kNoDeadline;
  rejectSuppressed_[0] = rejectSuppressed_[1] = 0;
  hasDroppedEvent_ = false;
  if (nvs_.get(nvs_keys::kDropped, s) && EventEntry::fromPayload(s, droppedEvent_)) hasDroppedEvent_ = true;
  droppedPersisted_ = hasDroppedEvent_;
  config_ = Config();
  if (nvs_.get(nvs_keys::kConfig, s)) {
    Json j;
    if (parseJson(s, j, ParseMode::Strict).ok && j.isObject()) config_.merge(j);
  }
  mode_ = Mode::Free;
  hasSession_ = false;
  serviceEndAt_ = holdEndAt_ = identifyEndAt_ = checkpointAt_ = graceBlinkAt_ = kNoDeadline;
  pulses_.clear();
  lampOff_ = false;
  otaBusy_ = false;
  bypass_ = Detector();
  lampFault_ = Detector();
  signals_ = Signals();
  halInit_ = false;

  bootPending_ = loadSavedSession(pending_);
  bootWindowAt_ = bootPending_ ? now + kBootWaitMs : kNoDeadline;

  Json data = Json::object();
  data.set("fw", Json::string(fw_));
  data.set("caps", caps_.toJson());
  data.set("reset_reason", Json::string(resetReason ? resetReason : "unknown"));
  emitEvent("boot", data);
  evaluateSensor(now);
  periodicAt_ = now + kStatePeriodMs;
  publish(true);
}

bool Machine::loadSavedSession(SavedSession& out) {
  std::string s;
  if (!nvs_.get(nvs_keys::kSession, s)) return false;
  Json j;
  if (!parseJson(s, j, ParseMode::Strict).ok || !j.isObject()) return false;
  const Json* id = j.get("session_id");
  const Json* rem = j.get("remaining_ms");
  const Json* warn = j.get("warn_ms");
  const Json* grace = j.get("grace_ms");
  const Json* buzzer = j.get("buzzer");
  const Json* resumes = j.get("offline_resumes");
  if (!id || !id->isString() || !rem || !rem->isInt() || !warn || !warn->isArray() || warn->items().size() != 2 ||
      !warn->items()[0].isInt() || !warn->items()[1].isInt() || !grace || !grace->isInt() || !buzzer || !buzzer->isBool() ||
      !resumes || !resumes->isInt()) {
    return false;
  }
  out.id = id->asString();
  out.remaining = rem->asInt();
  out.warn[0] = warn->items()[0].asInt();
  out.warn[1] = warn->items()[1].asInt();
  out.grace = grace->asInt();
  out.buzzer = buzzer->asBool();
  out.offlineResumes = resumes->asInt();
  return true;
}

void Machine::setOnline(bool online) {
  online_ = online;
  if (!online) persistEvents();
}

void Machine::sensorChanged(int64_t now) {
  now = sync(now);
  evaluateSensor(now);
  publish(false);
}

void Machine::otaResult(int64_t now, bool ok, const std::string& version, const std::string& error) {
  sync(now);
  if (!ok && !otaBusy_) return;  // обновление уже прервано командой (ota_failed: aborted)
  otaBusy_ = false;
  Json data = Json::object();
  data.set("version", Json::string(version));
  if (ok) {
    data.set("error", Json::null());
    emitEvent("ota_ok", data);
  } else {
    data.set("error", Json::string(error.empty() ? "unknown" : error));
    emitEvent("ota_failed", data);
  }
}

void Machine::otaRolledBack(int64_t now, const std::string& version) {
  sync(now);
  Json data = Json::object();
  data.set("version", Json::string(version));
  data.set("error", Json::string("rollback"));
  emitEvent("ota_failed", data);
}

void Machine::publishState(int64_t now) {
  sync(now);
  publish(true);
}

void Machine::tick(int64_t now) { advanceTo(now); }

// ——— state ———

Led Machine::led() const { return identifyEndAt_ != kNoDeadline ? Led::Identify : ledFor(reportedMode()); }

Json Machine::snapshot(int64_t now) const {
  now = std::max(now, t_);
  Mode mode = reportedMode();
  bool relay = relayOn();
  Json j = Json::object();
  j.set("v", Json::integer(1));
  j.set("state_seq", Json::integer(stateSeq_));
  j.set("mode", Json::string(modeName(mode)));
  j.set("session_id", hasSession_ ? Json::string(session_.id) : Json::null());
  Json remaining = Json::null();
  if (hasSession_) {
    remaining = Json::integer(mode_ == Mode::Grace ? 0 : std::max<int64_t>(0, session_.endAt - now));
  } else if (mode_ == Mode::Service) {
    remaining = Json::integer(std::max<int64_t>(0, serviceEndAt_ - now));
  }
  j.set("remaining_ms", remaining);
  j.set("relay", Json::boolean(relay));
  j.set("dim", Json::integer(dimLevel()));
  j.set("led", Json::string(ledName(led())));
  j.set("buzzer", Json::boolean(hasSession_ ? session_.buzzer : false));
  j.set("current_ma", caps_.current ? Json::integer(currentMa_) : Json::null());
  j.set("caps", caps_.toJson());
  j.set("fw", Json::string(fw_));
  j.set("boot", Json::integer(boot_));
  j.set("rssi", Json::integer(hal_.rssi()));
  j.set("uptime_s", Json::integer((now - bootAt_) / 1000));
  j.set("last_seq", Json::integer(lastSeq_));
  return j;
}

std::string Machine::changeKey() const {
  // «Изменение» по §4: mode, session_id, relay, dim, led, buzzer, caps.
  std::string k = modeName(reportedMode());
  k += '|';
  k += hasSession_ ? session_.id : "-";
  k += relayOn() ? "|1|" : "|0|";
  k += intToString(dimLevel());
  k += '|';
  k += ledName(led());
  k += (hasSession_ && session_.buzzer) ? "|1|" : "|0|";
  k += caps_.toJson().dump();
  return k;
}

void Machine::publish(bool force) {
  std::string key = changeKey();
  bool changed = !hasLastKey_ || key != lastKey_;
  if (!changed && !force) return;
  lastKey_ = key;
  hasLastKey_ = true;
  stateSeq_ += 1;
  out_->publishState(snapshot(t_).dump(), changed);
}

// ——— События ———

EventEntry Machine::makeEvent(const char* type, const Json& data) {
  eventN_ += 1;
  Json e = Json::object();
  e.set("v", Json::integer(1));
  e.set("boot", Json::integer(boot_));
  e.set("boot_id", Json::string(bootId_));
  e.set("n", Json::integer(eventN_));
  e.set("type", Json::string(type));
  e.set("at_uptime_ms", Json::integer(t_ - bootAt_));
  e.set("data", data);
  EventEntry entry;
  entry.used = true;
  entry.boot = boot_;
  entry.bootId = bootId_;
  entry.n = eventN_;
  entry.type = type;
  entry.payload = e.dump();
  return entry;
}

void Machine::emitEvent(const char* type, const Json& data) {
  EventEntry entry = makeEvent(type, data);
  ring_.push(entry);
  if (!online_) persistEvents();
  out_->eventCreated(entry);
}

// bad_sig и replayed_seq — не чаще одного каждого типа за 10 с; пропущенные — в data.suppressed следующего.
void Machine::emitRejectEvent(const char* type, const std::string& cmdId, int64_t seq) {
  int k = std::strcmp(type, "bad_sig") == 0 ? 0 : 1;
  int64_t now = t_ - bootAt_;
  if (rejectAt_[k] != kNoDeadline && now - rejectAt_[k] < kRejectEventIntervalMs) {
    rejectSuppressed_[k] += 1;
    return;
  }
  Json data = Json::object();
  data.set("cmd_id", Json::string(cmdId));
  data.set("seq", Json::integer(seq));
  if (rejectSuppressed_[k] > 0) data.set("suppressed", Json::integer(rejectSuppressed_[k]));
  emitEvent(type, data);
  rejectAt_[k] = now;
  rejectSuppressed_[k] = 0;
}

void Machine::persistEvents() {
  ring_.persist();
  if (hasDroppedEvent_ && !droppedPersisted_) {
    nvs_.set(nvs_keys::kDropped, droppedEvent_.payload);
    droppedPersisted_ = true;
  }
}

std::vector<EventEntry> Machine::outbox() {
  if (!hasDroppedEvent_) {
    int count = ring_.takeDropped();
    if (count > 0) {
      Json data = Json::object();
      data.set("count", Json::integer(count));
      droppedEvent_ = makeEvent("events_dropped", data);
      hasDroppedEvent_ = true;
      droppedPersisted_ = false;
    }
  }
  std::vector<EventEntry> list;
  if (hasDroppedEvent_) list.push_back(droppedEvent_);
  for (auto& e : ring_.list()) list.push_back(e);
  return list;
}

bool Machine::eventDelivered(const std::string& bootId, int64_t n) {
  if (hasDroppedEvent_ && droppedEvent_.bootId == bootId && droppedEvent_.n == n) {
    hasDroppedEvent_ = false;
    if (droppedPersisted_) nvs_.erase(nvs_keys::kDropped);
    droppedPersisted_ = false;
    return true;
  }
  return ring_.remove(bootId, n);
}

// ——— Команды ———

CommandReport Machine::handleCommand(int64_t now, const uint8_t* data, size_t len) {
  now = sync(now);
  CommandReport r = handle(now, data, len);
  out_->commandDone(r);
  return r;
}

CommandReport Machine::handle(int64_t now, const uint8_t* data, size_t len) {
  VerifyResult checked = verifyCommand(data, len, key_, hmac_);
  CommandReport rep;
  rep.hasEcho = checked.hasEcho;
  rep.cmdId = checked.cmdId;
  rep.seq = checked.seq;
  rep.type = checked.type;

  if (checked.status != VerifyStatus::Ok) {
    // bad_format: cmd_id и seq — null (§4); bad_sig: из разобранной команды.
    const char* error = checked.status == VerifyStatus::BadSig ? "bad_sig" : "bad_format";
    sendAck(ackPayload(checked.hasEcho, checked.cmdId, checked.seq, false, error, stateSeq_), checked.cmdId);
    if (checked.status == VerifyStatus::BadSig) emitRejectEvent("bad_sig", checked.cmdId, checked.seq);
    rep.result = error;
    rep.reason = checked.reason;
    return rep;
  }

  std::string s;
  ReplayRecord saved;
  if (nvs_.get(nvs_keys::kReplay, s)) saved = ReplayRecord::fromJson(s);
  ReplayDecision decision = decideReplay(saved, checked.seq, checked.cmdId);
  if (decision == ReplayDecision::Resend) {
    sendAck(ackPayload(saved), checked.cmdId);
    rep.result = "resend";
    return rep;
  }
  if (decision == ReplayDecision::Replayed) {
    sendAck(ackPayload(true, checked.cmdId, checked.seq, false, "replayed_seq", stateSeq_), checked.cmdId);
    emitRejectEvent("replayed_seq", checked.cmdId, checked.seq);
    rep.result = "replayed_seq";
    return rep;
  }

  // С шага 4 seq принят: исполнить → записать блок в NVS → опубликовать ack (§3.2).
  // state уходит до ack, поэтому ack.state_seq указывает на уже опубликованный state.
  lastSeq_ = checked.seq;
  Exec ex = execute(cmdTypeFrom(checked.type), checked.cmdId, *checked.cmd.get("body"), now);
  evaluateSensor(now);
  publish(ex.force);
  ReplayRecord rec;
  rec.valid = true;
  rec.seq = checked.seq;
  rec.id = checked.cmdId;
  rec.ok = ex.ok;
  rec.error = ex.ok ? "" : ex.error;
  rec.stateSeq = stateSeq_;
  nvs_.set(nvs_keys::kReplay, rec.toJson());
  sendAck(ackPayload(rec), checked.cmdId);
  rep.result = ex.ok ? "ok" : ex.error;
  rep.reason = ex.field;
  return rep;
}

Machine::Exec Machine::execute(CmdType type, const std::string& cmdId, const Json& bodyJson, int64_t now) {
  Exec ok;
  auto fail = [](const char* error) {
    Exec e;
    e.ok = false;
    e.error = error;
    return e;
  };
  Body body;
  BodyResult br = validateBody(type, bodyJson, body);
  if (br.status == BodyStatus::UnknownType) return fail("unknown_type");
  if (br.status == BodyStatus::BadBody) {
    Exec e = fail("bad_body");
    e.field = br.field;
    return e;
  }

  switch (type) {
    case CmdType::Ping:
      ok.force = true;
      return ok;

    case CmdType::Identify:
      if (!caps_.led) return fail("hw_fault");
      identifyEndAt_ = now + body.durationMs;
      return ok;

    case CmdType::ConfigSet:
      if (body.hasLedBrightness) config_.ledBrightness = body.ledBrightness;
      if (body.hasCurrentOnMa) config_.currentOnMa = body.currentOnMa;
      if (body.hasCurrentConfirmMs) config_.currentConfirmMs = body.currentConfirmMs;
      if (body.hasGraceDim) config_.graceDim = body.graceDim;
      if (body.hasGraceBlinkS) config_.graceBlinkS = body.graceBlinkS;
      nvs_.set(nvs_keys::kConfig, config_.toJson().dump());
      return ok;

    case CmdType::OtaStart:
      if (reportedMode() != Mode::Free || bootPending_ || otaBusy_) return fail("busy_ota");
      otaBusy_ = true;
      otaVersion_ = body.version;
      out_->otaStart(body);
      return ok;

    case CmdType::SessionStart:
    case CmdType::SessionResume: {
      bool wasOn = relayOn();
      abortOta();
      resolveBootWait();
      SavedSession p;
      p.id = body.sessionId;
      p.remaining = body.remainingMs;
      p.warn[0] = body.warn[0];
      p.warn[1] = body.warn[1];
      p.grace = body.graceMs;
      p.buzzer = body.buzzer;
      if (hasSession_ && session_.id == p.id) {
        continueSession(now, p);
      } else {
        leaveCurrent(now);
        beginSession(now, p, 0);
      }
      if (!wasOn && relayOn()) out_->relayOn(cmdId, cmdTypeName(type));
      return ok;
    }

    case CmdType::SessionExtend:
      if (!hasSession_ || session_.id != body.sessionId) return fail("wrong_session");
      session_.endAt = now + body.remainingMs;
      session_.buzzer = body.buzzer;
      session_.graceEndAt = kNoDeadline;
      graceBlinkAt_ = kNoDeadline;
      applyPhase(now, true);
      saveSession(now);
      return ok;

    case CmdType::SessionStop:
      if (hasSession_ && session_.id == body.sessionId) {
        endSession(now, false);
        return ok;
      }
      if (!hasSession_ && bootPending_ && pending_.id == body.sessionId) {
        resolveBootWait();  // сессия из NVS стирается
        return ok;
      }
      return fail("wrong_session");

    case CmdType::ServiceStart:
      if (hasSession_) return fail("wrong_session");
      abortOta();
      resolveBootWait();
      leaveCurrent(now);
      mode_ = Mode::Service;
      serviceEndAt_ = now + body.durationMs;
      return ok;

    case CmdType::ServiceStop:
      if (mode_ == Mode::Service) toFree();
      return ok;

    case CmdType::StateFree:
      resolveBootWait();
      leaveCurrent(now);
      toFree();
      return ok;

    case CmdType::StatePending:
    case CmdType::StateReserved:
      if (hasSession_ || mode_ == Mode::Service) return fail("wrong_session");
      abortOta();
      resolveBootWait();
      leaveCurrent(now);
      mode_ = type == CmdType::StatePending ? Mode::Pending : Mode::Reserved;
      holdEndAt_ = now + body.untilMs;
      return ok;

    case CmdType::Unknown:
      break;
  }
  return fail("unknown_type");
}

// Обновление идёт только в free: команда, занимающая стол, прерывает его,
// иначе контроллер перезагрузился бы в новую прошивку посреди игры.
void Machine::abortOta() {
  if (!otaBusy_) return;
  otaBusy_ = false;
  out_->otaAbort();
  Json data = Json::object();
  data.set("version", Json::string(otaVersion_));
  data.set("error", Json::string("aborted"));
  emitEvent("ota_failed", data);
}

// ——— Сессия и сигналы (§5) ———

// Команда сервера, задающая состояние, закрывает окно ожидания после загрузки:
// сессия из NVS либо заменяется новой, либо стирается.
void Machine::resolveBootWait() {
  if (!bootPending_) return;
  bootPending_ = false;
  bootWindowAt_ = kNoDeadline;
  nvs_.erase(nvs_keys::kSession);
}

void Machine::leaveCurrent(int64_t now) {
  if (hasSession_) endSession(now, false);
  toFree();
}

void Machine::toFree() {
  mode_ = Mode::Free;
  serviceEndAt_ = kNoDeadline;
  holdEndAt_ = kNoDeadline;
}

void Machine::beginSession(int64_t now, const SavedSession& p, int64_t offlineResumes) {
  mode_ = Mode::Active;
  hasSession_ = true;
  session_ = Session();
  session_.id = p.id;
  session_.endAt = now + p.remaining;
  session_.warn[0] = p.warn[0];
  session_.warn[1] = p.warn[1];
  session_.grace = p.grace;
  session_.buzzer = p.buzzer;
  session_.signaled = 0;
  session_.graceEndAt = kNoDeadline;
  session_.offlineResumes = offlineResumes;
  applyPhase(now, true);
  saveSession(now);
}

// session.start / session.resume той же сессии (возврат онлайн, перезапуск сервера, сверка):
// остаток и параметры заменяются, а фаза и прозвучавшие сигналы сохраняются — сигнал только при
// переходе в другую фазу, как у session.extend (§5: команда в пределах той же фазы сигнала не даёт).
void Machine::continueSession(int64_t now, const SavedSession& p) {
  session_.endAt = now + p.remaining;
  session_.warn[0] = p.warn[0];
  session_.warn[1] = p.warn[1];
  session_.grace = p.grace;
  session_.buzzer = p.buzzer;
  session_.graceEndAt = kNoDeadline;
  session_.offlineResumes = 0;  // §5 правило 4: сервер ответил — offline_resumes = 0
  graceBlinkAt_ = kNoDeadline;
  applyPhase(now, true);
  saveSession(now);
}

// Фаза по остатку: 0 — больше warn[0], 1 — до warn[1], 2 — до нуля, 3 — льгота.
int Machine::phaseAt(int64_t now) const {
  int64_t r = session_.endAt - now;
  if (r <= 0) return 3;
  if (r <= session_.warn[1]) return 2;
  if (r <= session_.warn[0]) return 1;
  return 0;
}

// byCommand — остаток задан командой: сигнал текущей фазы звучит один раз сразу, если он ещё
// не звучал в этой фазе; остаток выше порога взводит сигналы заново. По времени фаза только растёт.
void Machine::applyPhase(int64_t now, bool byCommand) {
  int p = phaseAt(now);
  if (p == 3) {
    enterGrace(now);
    return;
  }
  if (session_.signaled == 3) stopPulses();  // выход из льготы продлением
  mode_ = p == 0 ? Mode::Active : Mode::Ending;
  if (p == 0) {
    session_.signaled = 0;
  } else if (byCommand ? p != session_.signaled : p > session_.signaled) {
    session_.signaled = p;
    fireSignal(now, p);
  }
}

void Machine::fireSignal(int64_t now, int phase) {
  if (phase == 1) {
    int beeps = (session_.buzzer && caps_.buzzer) ? kWarnBeeps : 0;
    signals_.warn += 1;
    signals_.beep += beeps;
    if (beeps > 0) hal_.beep(beeps);
    out_->signal("warn", beeps);
  } else if (phase == 2) {
    // Лампа дважды мигает: выкл. 300, вкл. 300, выкл. 300, вкл.
    startPulses(now, 2);
    signals_.blink2 += 1;
    out_->signal("blink2", 0);
  }
}

void Machine::enterGrace(int64_t now) {
  if (session_.grace == 0) {
    endSession(now, true);
    return;
  }
  mode_ = Mode::Grace;
  session_.signaled = 3;
  session_.graceEndAt = session_.endAt + session_.grace;
  stopPulses();
  signals_.grace += 1;
  out_->signal("grace", 0);
  if (!caps_.dimmer) graceBlink(now);
  saveSession(now);
}

void Machine::graceBlink(int64_t now) {
  startPulses(now, 1);
  graceBlinkAt_ = now + config_.graceBlinkS * 1000;
  signals_.graceBlink += 1;
  out_->signal("grace_blink", 0);
}

// count погасаний лампы по kBlinkOffMs с паузой kBlinkOffMs; первое — сейчас.
void Machine::startPulses(int64_t now, int count) {
  lampOff_ = true;
  pulses_.clear();
  for (int i = 0; i < count; ++i) {
    int64_t off = now + 2 * i * kBlinkOffMs;
    if (i > 0) pulses_.push_back(Pulse{off, false});
    pulses_.push_back(Pulse{off + kBlinkOffMs, true});
  }
}

void Machine::stopPulses() {
  pulses_.clear();
  lampOff_ = false;
  graceBlinkAt_ = kNoDeadline;
}

// natural — доиграна до конца льготы (не командой).
void Machine::endSession(int64_t now, bool natural) {
  std::string id = session_.id;
  hasSession_ = false;
  mode_ = Mode::Free;
  stopPulses();
  checkpointAt_ = kNoDeadline;
  nvs_.erase(nvs_keys::kSession);
  if (natural && !online_) {
    Json data = Json::object();
    data.set("session_id", Json::string(id));
    data.set("finished_uptime_ms", Json::integer(now - bootAt_));
    emitEvent("offline_session_finished", data);
  }
}

// Сессия в NVS: при каждом изменении остатка командой, в начале льготы (остаток 0) и раз в S.
void Machine::saveSession(int64_t now) {
  int64_t remaining = mode_ == Mode::Grace ? 0 : std::max<int64_t>(0, session_.endAt - now);
  Json j = Json::object();
  j.set("session_id", Json::string(session_.id));
  j.set("remaining_ms", Json::integer(remaining));
  Json warn = Json::array();
  warn.push(Json::integer(session_.warn[0]));
  warn.push(Json::integer(session_.warn[1]));
  j.set("warn_ms", warn);
  j.set("grace_ms", Json::integer(session_.grace));
  j.set("buzzer", Json::boolean(session_.buzzer));
  j.set("offline_resumes", Json::integer(session_.offlineResumes));
  nvs_.set(nvs_keys::kSession, j.dump());
  checkpointAt_ = mode_ == Mode::Grace ? kNoDeadline : now + kSessionSaveMs;
}

// §5 правило 4: сервер не ответил за kBootWaitMs.
void Machine::bootWaitExpired(int64_t now) {
  bool had = bootPending_;
  SavedSession saved = pending_;
  bootPending_ = false;
  bootWindowAt_ = kNoDeadline;
  if (!had) return;
  if (saved.offlineResumes >= 1) {
    nvs_.erase(nvs_keys::kSession);
    Json data = Json::object();
    data.set("session_id", Json::string(saved.id));
    emitEvent("offline_resume_denied", data);
    return;
  }
  int64_t resumed = saved.remaining - kSessionSaveMs;
  if (resumed <= 0) {
    nvs_.erase(nvs_keys::kSession);
    return;
  }
  SavedSession p = saved;
  p.remaining = resumed;
  beginSession(now, p, 1);
  Json data = Json::object();
  data.set("session_id", Json::string(saved.id));
  data.set("saved_ms", Json::integer(saved.remaining));
  data.set("resumed_ms", Json::integer(resumed));
  emitEvent("offline_resume", data);
}

// ——— Выходы ———

bool Machine::relayOn() const {
  return mode_ == Mode::Active || mode_ == Mode::Ending || mode_ == Mode::Grace || mode_ == Mode::Service;
}

bool Machine::lampOn() const { return relayOn() && !lampOff_; }

int Machine::dimLevel() const {
  if (!relayOn()) return 0;
  if (mode_ == Mode::Grace && caps_.dimmer) return (int)config_.graceDim;
  return 100;
}

Mode Machine::reportedMode() const {
  if (isIdle(mode_) && faulty()) return Mode::Fault;
  return mode_;
}

void Machine::applyOutputs() {
  bool relay = lampOn();
  int dim = dimLevel();
  Led l = led();
  int brightness = (int)config_.ledBrightness;
  if (!halInit_ || relay != halRelay_) hal_.setRelay(relay);
  if (!halInit_ || dim != halDim_) hal_.setDim(dim);
  if (!halInit_ || l != halLed_ || brightness != halBrightness_) hal_.setLed(l, brightness);
  halInit_ = true;
  halRelay_ = relay;
  halDim_ = dim;
  halLed_ = l;
  halBrightness_ = brightness;
}

// ——— Датчик тока (§5 правило 5) ———

void Machine::evaluateSensor(int64_t now) {
  applyOutputs();
  if (!caps_.current) return;
  bool lamp = lampOn();
  int dim = dimLevel();
  int32_t ma = hal_.currentMa();
  if (ma < 0) ma = 0;
  currentMa_ = ma;
  int64_t onMa = config_.currentOnMa;
  track(bypass_.since, bypass_.latched, !relayOn() && ma >= onMa, now);
  track(lampFault_.since, lampFault_.latched, lamp && dim == 100 && ma < onMa, now);
}

void Machine::sensorDue(int64_t now) {
  int64_t confirm = config_.currentConfirmMs;
  Detector* ds[2] = {&bypass_, &lampFault_};
  const char* types[2] = {"bypass_detected", "lamp_fault"};
  for (int i = 0; i < 2; ++i) {
    Detector& d = *ds[i];
    if (d.since != kNoDeadline && !d.latched && d.since + confirm <= now) {
      d.latched = true;
      Json data = Json::object();
      data.set("current_ma", Json::integer(currentMa_));
      emitEvent(types[i], data);
    }
  }
}

// ——— Сроки ———

int64_t Machine::sessionDeadline() const {
  if (!hasSession_) return kNoDeadline;
  if (mode_ == Mode::Grace) return session_.graceEndAt;
  if (session_.signaled == 0) return session_.endAt - session_.warn[0];
  if (session_.signaled == 1) return session_.endAt - session_.warn[1];
  return session_.endAt;
}

int64_t Machine::sensorDeadline() const {
  int64_t confirm = config_.currentConfirmMs;
  int64_t d = kNoDeadline;
  if (bypass_.since != kNoDeadline && !bypass_.latched) d = std::min(d, bypass_.since + confirm);
  if (lampFault_.since != kNoDeadline && !lampFault_.latched) d = std::min(d, lampFault_.since + confirm);
  return d;
}

int64_t Machine::nextDeadline() const {
  int64_t ds[] = {
      bootWindowAt_, sessionDeadline(), pulses_.empty() ? kNoDeadline : pulses_.front().at,
      graceBlinkAt_, serviceEndAt_,     holdEndAt_,
      identifyEndAt_, checkpointAt_,    sensorDeadline(),
      periodicAt_,
  };
  int64_t d = kNoDeadline;
  for (int64_t x : ds) d = std::min(d, x);
  return d;
}

// Все события момента t — в постоянном порядке (тот же порядок в симуляторе).
void Machine::runDue(int64_t t) {
  if (bootWindowAt_ != kNoDeadline && bootWindowAt_ <= t) bootWaitExpired(t);
  for (int guard = 0; guard < 8; ++guard) {
    int64_t d = sessionDeadline();
    if (d == kNoDeadline || d > t) break;
    if (mode_ == Mode::Grace) {
      endSession(t, true);
    } else {
      applyPhase(t, false);
    }
  }
  while (!pulses_.empty() && pulses_.front().at <= t) {
    lampOff_ = !pulses_.front().on;
    pulses_.erase(pulses_.begin());
  }
  if (graceBlinkAt_ != kNoDeadline && graceBlinkAt_ <= t) graceBlink(t);
  if (serviceEndAt_ != kNoDeadline && serviceEndAt_ <= t) toFree();
  if (holdEndAt_ != kNoDeadline && holdEndAt_ <= t) toFree();
  if (identifyEndAt_ != kNoDeadline && identifyEndAt_ <= t) identifyEndAt_ = kNoDeadline;
  if (checkpointAt_ != kNoDeadline && checkpointAt_ <= t) saveSession(t);
  evaluateSensor(t);
  sensorDue(t);
  bool periodic = false;
  if (periodicAt_ != kNoDeadline && periodicAt_ <= t) {
    periodic = true;
    periodicAt_ = t + kStatePeriodMs;
  }
  publish(periodic);
}

// Сроки до now — по порядку, каждый в свой момент; время обработки не идёт назад
// (срок в прошлом, например после уменьшения current_confirm_ms, срабатывает сейчас).
void Machine::advanceTo(int64_t now) {
  for (int guard = 0; guard < 10000; ++guard) {
    int64_t d = nextDeadline();
    if (d == kNoDeadline || d > now) return;
    t_ = std::max(d, t_);
    runDue(t_);
  }
}

// Вход снаружи (команда, датчик, OTA): догнать сроки до текущего времени.
int64_t Machine::sync(int64_t now) {
  int64_t n = std::max(now, t_);
  advanceTo(n);
  t_ = n;
  return n;
}

}  // namespace bl
