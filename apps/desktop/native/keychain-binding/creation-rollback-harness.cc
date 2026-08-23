#include "creation-rollback.h"

#include <array>
#include <cstdlib>
#include <cstring>

namespace {

using enduragent::keychain::CreationRollbackAddResult;
using enduragent::keychain::CreationRollbackBufferResult;
using enduragent::keychain::CreationRollbackContentResult;
using enduragent::keychain::CreationRollbackDebt;
using enduragent::keychain::CreationRollbackDependencies;
using enduragent::keychain::CreationRollbackResult;
using enduragent::keychain::ReleaseCreationRollbackDebt;
using enduragent::keychain::RetryCreationRollback;
using enduragent::keychain::RunCreationRollbackTransaction;

constexpr size_t kLength = 32;
constexpr char kService[] = "icu.enduragent.desktop.dev";
constexpr char kOtherService[] = "icu.enduragent.desktop";
constexpr char kPrepareFailure[] = "prepare-failure";
constexpr char kAddFailure[] = "add-failure";
constexpr char kInspectFailure[] = "inspect-failure";
constexpr char kCopyFailure[] = "copy-failure";
constexpr char kFreeFailure[] = "free-failure";
constexpr char kBufferFailure[] = "buffer-failure";
constexpr char kPublishFailure[] = "publish-failure";
constexpr char kDeleteFailure[] = "delete-failure";

int exactToken = 0;
int wrongToken = 0;

struct Fake {
  const char *prepareCode = nullptr;
  const char *addCode = nullptr;
  void *addRef = &exactToken;
  bool addExact = true;
  const char *inspectCode = nullptr;
  const char *copyCode = nullptr;
  bool copyNull = false;
  size_t copyLength = kLength;
  const char *freeCode = nullptr;
  const char *bufferCode = nullptr;
  bool bufferNull = false;
  bool bufferBytesOnFailure = false;
  bool bufferValueNull = false;
  bool bufferBytesNull = false;
  size_t bufferLength = kLength;
  const char *publishCode = nullptr;
  const char *deleteCode = nullptr;
  std::array<unsigned char, kLength> persisted{};
  std::array<unsigned char, kLength> buffer{};
  int prepareCalls = 0;
  int addCalls = 0;
  int inspectCalls = 0;
  int copyCalls = 0;
  int freeCalls = 0;
  int bufferCalls = 0;
  int publishCalls = 0;
  int wipeCalls = 0;
  int deleteCalls = 0;
  int releaseCalls = 0;
  int eraseCalls = 0;
  void *releasedRef = nullptr;
};

void Require(bool condition) {
  if (!condition)
    std::abort();
}

const char *Prepare(void *context) {
  auto &fake = *static_cast<Fake *>(context);
  fake.prepareCalls += 1;
  return fake.prepareCode;
}

CreationRollbackAddResult Add(void *context) {
  auto &fake = *static_cast<Fake *>(context);
  fake.addCalls += 1;
  return {fake.addCode, fake.addRef, fake.addExact};
}

const char *Inspect(void *context, void *exactRef) {
  auto &fake = *static_cast<Fake *>(context);
  Require(exactRef == &exactToken);
  fake.inspectCalls += 1;
  return fake.inspectCode;
}

CreationRollbackContentResult CopyContent(void *context, void *exactRef) {
  auto &fake = *static_cast<Fake *>(context);
  Require(exactRef == &exactToken);
  fake.copyCalls += 1;
  return {fake.copyCode, fake.copyNull ? nullptr : fake.persisted.data(),
          fake.copyLength};
}

const char *FreeContent(void *context, void *bytes, size_t length) {
  auto &fake = *static_cast<Fake *>(context);
  Require(bytes == fake.persisted.data());
  Require(length == fake.copyLength);
  fake.freeCalls += 1;
  std::memset(bytes, 0, length);
  return fake.freeCode;
}

CreationRollbackBufferResult CreateBuffer(void *context,
                                          const unsigned char *material,
                                          size_t length) {
  auto &fake = *static_cast<Fake *>(context);
  fake.bufferCalls += 1;
  Require(length == kLength);
  std::memcpy(fake.buffer.data(), material, length);
  if (fake.bufferCode != nullptr && !fake.bufferBytesOnFailure)
    return {fake.bufferCode, nullptr, nullptr, 0};
  if (fake.bufferNull)
    return {fake.bufferCode, nullptr, nullptr, 0};
  return {fake.bufferCode, fake.bufferValueNull ? nullptr : &fake,
          fake.bufferBytesNull ? nullptr : fake.buffer.data(),
          fake.bufferLength};
}

const char *PublishBuffer(void *context, void *value) {
  auto &fake = *static_cast<Fake *>(context);
  Require(value == &fake);
  fake.publishCalls += 1;
  return fake.publishCode;
}

void WipeBuffer(void *context, unsigned char *bytes, size_t length) {
  auto &fake = *static_cast<Fake *>(context);
  Require(bytes == fake.buffer.data());
  fake.wipeCalls += 1;
  std::memset(bytes, 0, length);
}

const char *DeleteExact(void *context, void *exactRef) {
  auto &fake = *static_cast<Fake *>(context);
  Require(exactRef == &exactToken);
  fake.deleteCalls += 1;
  return fake.deleteCode;
}

void ReleaseRef(void *context, void *ref) {
  auto &fake = *static_cast<Fake *>(context);
  fake.releaseCalls += 1;
  fake.releasedRef = ref;
}

void EraseMaterial(void *context, unsigned char *material, size_t length) {
  auto &fake = *static_cast<Fake *>(context);
  fake.eraseCalls += 1;
  std::memset(material, 0, length);
}

CreationRollbackDependencies Dependencies(Fake &fake) {
  return {&fake,       Prepare,      Add,          Inspect,
          CopyContent, FreeContent,  CreateBuffer, PublishBuffer,
          WipeBuffer, DeleteExact,   ReleaseRef,   EraseMaterial};
}

std::array<unsigned char, kLength> Material() {
  std::array<unsigned char, kLength> material{};
  for (size_t index = 0; index < material.size(); index += 1)
    material[index] = static_cast<unsigned char>(index + 1);
  return material;
}

void PreparePersisted(Fake &fake,
                      const std::array<unsigned char, kLength> &material) {
  fake.persisted = material;
}

void RequireErased(const std::array<unsigned char, kLength> &material) {
  for (const unsigned char byte : material)
    Require(byte == 0);
}

CreationRollbackResult Run(Fake &fake, CreationRollbackDebt &debt,
                           std::array<unsigned char, kLength> &material) {
  PreparePersisted(fake, material);
  return RunCreationRollbackTransaction(kService, material.data(),
                                        material.size(), debt,
                                        Dependencies(fake));
}

void RequireFailure(const CreationRollbackResult &result, const char *code,
                    bool pending) {
  Require(!result.ok);
  Require(std::strcmp(result.code, code) == 0);
  Require(result.creationRollbackPending == pending);
}

void TestPreAddFailures() {
  {
    Fake fake;
    CreationRollbackDebt debt{true, &exactToken, kService};
    auto material = Material();
    const CreationRollbackResult result = Run(fake, debt, material);
    RequireFailure(result, "uninspectable-item", true);
    Require(fake.prepareCalls == 0);
    Require(fake.addCalls == 0);
    Require(fake.deleteCalls == 0);
    Require(fake.releaseCalls == 0);
    Require(fake.eraseCalls == 1);
    RequireErased(material);
  }
  {
    Fake fake;
    fake.prepareCode = kPrepareFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    const CreationRollbackResult result = Run(fake, debt, material);
    RequireFailure(result, kPrepareFailure, false);
    Require(fake.addCalls == 0);
    Require(fake.deleteCalls == 0);
    Require(fake.releaseCalls == 0);
    Require(fake.eraseCalls == 1);
    RequireErased(material);
  }
  {
    Fake fake;
    fake.addCode = kAddFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    const CreationRollbackResult result = Run(fake, debt, material);
    RequireFailure(result, kAddFailure, false);
    Require(fake.addCalls == 1);
    Require(fake.deleteCalls == 0);
    Require(fake.releaseCalls == 1);
    Require(fake.releasedRef == &exactToken);
    Require(fake.eraseCalls == 1);
    RequireErased(material);
  }
}

void TestUnknownReferences() {
  {
    Fake fake;
    fake.addRef = nullptr;
    CreationRollbackDebt debt;
    auto material = Material();
    const CreationRollbackResult result = Run(fake, debt, material);
    RequireFailure(result, "unreadable-item", true);
    Require(debt.pending);
    Require(debt.exactRef == nullptr);
    Require(debt.service == kService);
    Require(fake.deleteCalls == 0);
    Require(fake.releaseCalls == 0);
    const CreationRollbackResult retry =
        RetryCreationRollback(kService, debt, Dependencies(fake));
    RequireFailure(retry, "uninspectable-item", true);
    Require(debt.pending);
    Require(fake.deleteCalls == 0);
    ReleaseCreationRollbackDebt(debt, Dependencies(fake));
    Require(fake.releaseCalls == 0);
  }
  {
    Fake fake;
    fake.addRef = &wrongToken;
    fake.addExact = false;
    CreationRollbackDebt debt;
    auto material = Material();
    const CreationRollbackResult result = Run(fake, debt, material);
    RequireFailure(result, "unreadable-item", true);
    Require(debt.pending);
    Require(debt.exactRef == nullptr);
    Require(fake.deleteCalls == 0);
    Require(fake.releaseCalls == 1);
    Require(fake.releasedRef == &wrongToken);
  }
}

void RequireRolledBack(Fake &fake, CreationRollbackDebt &debt,
                       std::array<unsigned char, kLength> &material,
                       const char *code) {
  const CreationRollbackResult result = Run(fake, debt, material);
  RequireFailure(result, code, false);
  Require(!debt.pending);
  Require(fake.deleteCalls == 1);
  Require(fake.releaseCalls == 1);
  Require(fake.releasedRef == &exactToken);
  Require(fake.eraseCalls == 1);
  RequireErased(material);
}

void TestEveryPostAddFailure() {
  {
    Fake fake;
    fake.inspectCode = kInspectFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kInspectFailure);
    Require(fake.copyCalls == 0);
  }
  {
    Fake fake;
    fake.copyCode = kCopyFailure;
    fake.freeCode = kFreeFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kCopyFailure);
    Require(fake.freeCalls == 1);
  }
  {
    Fake fake;
    fake.copyNull = true;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unreadable-item");
    Require(fake.freeCalls == 0);
  }
  {
    Fake fake;
    fake.copyLength = kLength - 1;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unreadable-item");
    Require(fake.freeCalls == 1);
  }
  {
    Fake fake;
    CreationRollbackDebt debt;
    auto material = Material();
    PreparePersisted(fake, material);
    fake.persisted[0] ^= 1;
    const CreationRollbackResult result = RunCreationRollbackTransaction(
        kService, material.data(), material.size(), debt, Dependencies(fake));
    RequireFailure(result, "unreadable-item", false);
    Require(fake.freeCalls == 1);
    Require(fake.deleteCalls == 1);
    Require(fake.releaseCalls == 1);
    RequireErased(material);
  }
  {
    Fake fake;
    fake.freeCode = kFreeFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kFreeFailure);
    Require(fake.freeCalls == 1);
  }
  {
    Fake fake;
    fake.bufferCode = kBufferFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kBufferFailure);
    Require(fake.wipeCalls == 0);
  }
  {
    Fake fake;
    fake.bufferCode = kBufferFailure;
    fake.bufferBytesOnFailure = true;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kBufferFailure);
    Require(fake.wipeCalls == 1);
    RequireErased(fake.buffer);
  }
  {
    Fake fake;
    fake.bufferNull = true;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unknown");
    Require(fake.wipeCalls == 0);
  }
  {
    Fake fake;
    fake.bufferValueNull = true;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unknown");
    Require(fake.wipeCalls == 1);
    RequireErased(fake.buffer);
  }
  {
    Fake fake;
    fake.bufferBytesNull = true;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unknown");
    Require(fake.wipeCalls == 0);
  }
  {
    Fake fake;
    fake.bufferLength = kLength - 1;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, "unknown");
    Require(fake.wipeCalls == 1);
    for (size_t index = 0; index < fake.bufferLength; index += 1)
      Require(fake.buffer[index] == 0);
    Require(fake.buffer.back() != 0);
  }
  {
    Fake fake;
    fake.publishCode = kPublishFailure;
    CreationRollbackDebt debt;
    auto material = Material();
    RequireRolledBack(fake, debt, material, kPublishFailure);
    Require(fake.publishCalls == 1);
    Require(fake.wipeCalls == 1);
    RequireErased(fake.buffer);
  }
}

void TestRollbackDebtRetryAndCleanup() {
  Fake fake;
  fake.inspectCode = kInspectFailure;
  fake.deleteCode = kDeleteFailure;
  CreationRollbackDebt debt;
  auto material = Material();
  const CreationRollbackResult result = Run(fake, debt, material);
  RequireFailure(result, kInspectFailure, true);
  Require(debt.pending);
  Require(debt.exactRef == &exactToken);
  Require(fake.deleteCalls == 1);
  Require(fake.releaseCalls == 0);

  const CreationRollbackResult mismatch =
      RetryCreationRollback(kOtherService, debt, Dependencies(fake));
  RequireFailure(mismatch, "uninspectable-item", true);
  Require(fake.deleteCalls == 1);

  const CreationRollbackResult failedRetry =
      RetryCreationRollback(kService, debt, Dependencies(fake));
  RequireFailure(failedRetry, kDeleteFailure, true);
  Require(fake.deleteCalls == 2);
  Require(fake.releaseCalls == 0);

  fake.deleteCode = nullptr;
  const CreationRollbackResult successfulRetry =
      RetryCreationRollback(kService, debt, Dependencies(fake));
  Require(successfulRetry.ok);
  Require(!debt.pending);
  Require(fake.deleteCalls == 3);
  Require(fake.releaseCalls == 1);

  const CreationRollbackResult noDebt =
      RetryCreationRollback(kService, debt, Dependencies(fake));
  Require(noDebt.ok);
  Require(fake.deleteCalls == 3);

  Fake cleanupFake;
  cleanupFake.inspectCode = kInspectFailure;
  cleanupFake.deleteCode = kDeleteFailure;
  CreationRollbackDebt cleanupDebt;
  auto cleanupMaterial = Material();
  Run(cleanupFake, cleanupDebt, cleanupMaterial);
  Require(cleanupFake.releaseCalls == 0);
  const int deletesBeforeCleanup = cleanupFake.deleteCalls;
  ReleaseCreationRollbackDebt(cleanupDebt, Dependencies(cleanupFake));
  Require(cleanupFake.releaseCalls == 1);
  Require(cleanupFake.deleteCalls == deletesBeforeCleanup);
}

void TestSuccess() {
  Fake fake;
  CreationRollbackDebt debt;
  auto material = Material();
  const auto expected = material;
  const CreationRollbackResult result = Run(fake, debt, material);
  Require(result.ok);
  Require(result.code == nullptr);
  Require(!result.creationRollbackPending);
  Require(fake.prepareCalls == 1);
  Require(fake.addCalls == 1);
  Require(fake.inspectCalls == 1);
  Require(fake.copyCalls == 1);
  Require(fake.freeCalls == 1);
  Require(fake.bufferCalls == 1);
  Require(fake.publishCalls == 1);
  Require(fake.wipeCalls == 0);
  Require(fake.deleteCalls == 0);
  Require(fake.releaseCalls == 1);
  Require(fake.eraseCalls == 1);
  RequireErased(fake.persisted);
  Require(fake.buffer == expected);
  RequireErased(material);
}

}

int main() {
  TestPreAddFailures();
  TestUnknownReferences();
  TestEveryPostAddFailure();
  TestRollbackDebtRetryAndCleanup();
  TestSuccess();
  return 0;
}
