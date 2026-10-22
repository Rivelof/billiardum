#include "bl_replay.h"

namespace bl {

std::string ReplayRecord::toJson() const {
  Json j = Json::object();
  j.set("seq", Json::integer(seq));
  j.set("id", Json::string(id));
  j.set("ok", Json::boolean(ok));
  j.set("error", ok ? Json::null() : Json::string(error));
  j.set("state_seq", Json::integer(stateSeq));
  return j.dump();
}

ReplayRecord ReplayRecord::fromJson(const std::string& s) {
  ReplayRecord r;
  Json j;
  if (!parseJson(s, j, ParseMode::Strict).ok || !j.isObject()) return r;
  const Json* seq = j.get("seq");
  const Json* id = j.get("id");
  const Json* ok = j.get("ok");
  const Json* error = j.get("error");
  const Json* stateSeq = j.get("state_seq");
  if (!seq || !seq->isInt() || !id || !id->isString() || !ok || !ok->isBool() || !stateSeq || !stateSeq->isInt()) return r;
  r.valid = true;
  r.seq = seq->asInt();
  r.id = id->asString();
  r.ok = ok->asBool();
  r.error = (error && error->isString()) ? error->asString() : std::string();
  r.stateSeq = stateSeq->asInt();
  return r;
}

ReplayDecision decideReplay(const ReplayRecord& saved, int64_t seq, const std::string& id) {
  int64_t savedSeq = saved.valid ? saved.seq : 0;
  if (seq > savedSeq) return ReplayDecision::Execute;
  if (saved.valid && seq == savedSeq && saved.id == id) return ReplayDecision::Resend;
  return ReplayDecision::Replayed;
}

std::string ackPayload(bool hasEcho, const std::string& cmdId, int64_t seq, bool ok, const std::string& error, int64_t stateSeq) {
  std::string out = "{\"v\":1,\"cmd_id\":";
  out += hasEcho ? "\"" + cmdId + "\"" : "null";
  out += ",\"seq\":";
  out += hasEcho ? intToString(seq) : "null";
  out += ",\"ok\":";
  out += ok ? "true" : "false";
  out += ",\"error\":";
  out += ok ? "null" : "\"" + error + "\"";
  out += ",\"state_seq\":";
  out += intToString(stateSeq);
  out += "}";
  return out;
}

}  // namespace bl
