#include "creation-rollback.h"

namespace enduragent::keychain {

namespace {

constexpr char kUnknown[] = "unknown";
constexpr char kUnreadableItem[] = "unreadable-item";
constexpr char kUninspectableItem[] = "uninspectable-item";

void ClearDebt(CreationRollbackDebt &debt) {
  debt.pending = false;
  debt.exactRef = nullptr;
  debt.service.clear();
}

bool BytesMatch(const void *persisted, size_t persistedLength,
                const unsigned char *material, size_t materialLength) {
  if (persisted == nullptr || persistedLength != materialLength)
    return false;
  const auto *persistedBytes = static_cast<const unsigned char *>(persisted);
  unsigned char difference = 0;
  for (size_t index = 0; index < materialLength; index += 1)
    difference |= persistedBytes[index] ^ material[index];
  return difference == 0;
}

CreationRollbackResult PreAddFailure(
    const char *code, unsigned char *material, size_t length,
    const CreationRollbackDependencies &dependencies) {
  dependencies.eraseMaterial(dependencies.context, material, length);
  return {false, code == nullptr ? kUnknown : code, false};
}

CreationRollbackResult UnknownReferenceFailure(
    const std::string &service, void *ref, unsigned char *material,
    size_t length, CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies) {
  if (ref != nullptr)
    dependencies.releaseRef(dependencies.context, ref);
  debt.pending = true;
  debt.exactRef = nullptr;
  debt.service = service;
  dependencies.eraseMaterial(dependencies.context, material, length);
  return {false, kUnreadableItem, true};
}

CreationRollbackResult PostAddFailure(
    const std::string &service, const char *primaryCode, void *exactRef,
    unsigned char *material, size_t materialLength,
    CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies,
    const CreationRollbackBufferResult *buffer) {
  if (buffer != nullptr && buffer->bytes != nullptr)
    dependencies.wipeBuffer(dependencies.context, buffer->bytes,
                            buffer->length);
  const char *rollbackCode =
      dependencies.deleteExact(dependencies.context, exactRef);
  if (rollbackCode == nullptr) {
    dependencies.releaseRef(dependencies.context, exactRef);
    ClearDebt(debt);
  } else {
    debt.pending = true;
    debt.exactRef = exactRef;
    debt.service = service;
  }
  dependencies.eraseMaterial(dependencies.context, material, materialLength);
  return {false, primaryCode == nullptr ? kUnknown : primaryCode,
          rollbackCode != nullptr};
}

}

CreationRollbackResult RunCreationRollbackTransaction(
    const std::string &service, unsigned char *material, size_t length,
    CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies) {
  if (debt.pending) {
    dependencies.eraseMaterial(dependencies.context, material, length);
    return {false, kUninspectableItem, true};
  }

  const char *primaryCode =
      dependencies.prepareResponse(dependencies.context);
  if (primaryCode != nullptr)
    return PreAddFailure(primaryCode, material, length, dependencies);

  const CreationRollbackAddResult added =
      dependencies.add(dependencies.context);
  if (added.code != nullptr) {
    if (added.ref != nullptr)
      dependencies.releaseRef(dependencies.context, added.ref);
    return PreAddFailure(added.code, material, length, dependencies);
  }
  if (added.ref == nullptr || !added.exactRef)
    return UnknownReferenceFailure(service, added.ref, material, length, debt,
                                   dependencies);

  primaryCode = dependencies.inspect(dependencies.context, added.ref);
  if (primaryCode != nullptr)
    return PostAddFailure(service, primaryCode, added.ref, material, length,
                          debt, dependencies, nullptr);

  const CreationRollbackContentResult content =
      dependencies.copyContent(dependencies.context, added.ref);
  primaryCode = content.code;
  if (primaryCode == nullptr &&
      !BytesMatch(content.bytes, content.length, material, length))
    primaryCode = kUnreadableItem;
  if (content.bytes != nullptr) {
    const char *freeCode =
        dependencies.freeContent(dependencies.context, content.bytes,
                                 content.length);
    if (primaryCode == nullptr && freeCode != nullptr)
      primaryCode = freeCode;
  }
  if (primaryCode != nullptr)
    return PostAddFailure(service, primaryCode, added.ref, material, length,
                          debt, dependencies, nullptr);

  const CreationRollbackBufferResult buffer =
      dependencies.createBuffer(dependencies.context, material, length);
  primaryCode = buffer.code;
  if (primaryCode == nullptr &&
      (buffer.value == nullptr || buffer.bytes == nullptr ||
       buffer.length != length))
    primaryCode = kUnknown;
  if (primaryCode != nullptr)
    return PostAddFailure(service, primaryCode, added.ref, material, length,
                          debt, dependencies, &buffer);

  primaryCode =
      dependencies.publishBuffer(dependencies.context, buffer.value);
  if (primaryCode != nullptr)
    return PostAddFailure(service, primaryCode, added.ref, material, length,
                          debt, dependencies, &buffer);

  dependencies.releaseRef(dependencies.context, added.ref);
  dependencies.eraseMaterial(dependencies.context, material, length);
  ClearDebt(debt);
  return {true, nullptr, false};
}

CreationRollbackResult RetryCreationRollback(
    const std::string &service, CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies) {
  if (!debt.pending)
    return {true, nullptr, false};
  if (debt.exactRef == nullptr || debt.service != service)
    return {false, kUninspectableItem, true};
  const char *code =
      dependencies.deleteExact(dependencies.context, debt.exactRef);
  if (code != nullptr)
    return {false, code, true};
  dependencies.releaseRef(dependencies.context, debt.exactRef);
  ClearDebt(debt);
  return {true, nullptr, false};
}

void ReleaseCreationRollbackDebt(
    CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies) {
  if (debt.exactRef != nullptr)
    dependencies.releaseRef(dependencies.context, debt.exactRef);
  ClearDebt(debt);
}

}
