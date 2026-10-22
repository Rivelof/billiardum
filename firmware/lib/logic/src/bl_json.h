// Строгий JSON команд и каноническая строка — docs/protocol.md §3.1.
// Своя реализация вместо ArduinoJson: тот по умолчанию принимает одинарные кавычки,
// ведущие нули и не видит повторяющихся ключей и `-0`, а здесь всё это — bad_format.
// Та же логика в симуляторе: tools/device-sim/lib/canonical.mjs.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace bl {

constexpr int64_t kMaxSafeInt = 9007199254740991LL;  // 2^53 − 1
constexpr size_t kMaxCommandBytes = 2048;
constexpr int kMaxDepth = 8;

class Json {
 public:
  enum class Type : uint8_t { Null, Bool, Int, String, Array, Object };

  Json() = default;
  static Json null() { return Json(); }
  static Json boolean(bool v);
  static Json integer(int64_t v);
  static Json string(std::string v);
  static Json array();
  static Json object();

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBool() const { return type_ == Type::Bool; }
  bool isInt() const { return type_ == Type::Int; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  bool asBool() const { return b_; }
  int64_t asInt() const { return i_; }
  const std::string& asString() const { return s_; }
  const std::vector<Json>& items() const { return arr_; }
  const std::vector<std::pair<std::string, Json>>& members() const { return obj_; }

  // Объект: поиск по ключу (nullptr — нет). Порядок членов — как в исходном тексте.
  const Json* get(const std::string& key) const;
  bool has(const std::string& key) const { return get(key) != nullptr; }

  // Построение (для событий, state, тестов).
  Json& push(Json v);
  Json& set(const std::string& key, Json v);  // заменяет или добавляет в конец

  // Запись в порядке членов, без пробелов; строки без экранирования (только печатный ASCII).
  std::string dump() const;

 private:
  friend class Parser;
  Type type_ = Type::Null;
  bool b_ = false;
  int64_t i_ = 0;
  std::string s_;
  std::vector<Json> arr_;
  std::vector<std::pair<std::string, Json>> obj_;
};

enum class ParseMode : uint8_t {
  // Команды §3.1: без обратной косой черты, только печатный ASCII в строках, только целые
  // в пределах ±(2^53−1) без `-0`, без повторяющихся ключей, вложенность ≤ kMaxDepth,
  // поле `sig` только на верхнем уровне.
  Strict,
  // Файлы тестов (векторы, сценарии): экранирование и UTF-8 в строках разрешены.
  Relaxed,
};

struct ParseResult {
  bool ok = false;
  const char* reason = "";  // причина для лога: json_syntax, backslash, duplicate_key, …
};

ParseResult parseJson(const char* data, size_t len, Json& out, ParseMode mode);
inline ParseResult parseJson(const std::string& s, Json& out, ParseMode mode) {
  return parseJson(s.data(), s.size(), out, mode);
}

// Каноническая строка: ключи по возрастанию байтов на всех уровнях, без пробелов.
// omitTopLevelKey — ключ верхнего уровня, который не входит (`sig`), или nullptr.
std::string canonicalize(const Json& v, const char* omitTopLevelKey);

// Печатный ASCII 0x20–0x7E без `"` и `\`.
bool isPrintableAscii(const std::string& s);

std::string intToString(int64_t v);

}  // namespace bl
