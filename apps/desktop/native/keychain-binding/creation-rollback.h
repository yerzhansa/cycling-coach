#pragma once

#include <cstddef>
#include <string>

namespace enduragent::keychain {

struct CreationRollbackDebt {
  bool pending = false;
  void *exactRef = nullptr;
  std::string service;
};

struct CreationRollbackResult {
  bool ok;
  const char *code;
  bool creationRollbackPending;
};

struct CreationRollbackAddResult {
  const char *code;
  void *ref;
  bool exactRef;
};

struct CreationRollbackContentResult {
  const char *code;
  void *bytes;
  size_t length;
};

struct CreationRollbackBufferResult {
  const char *code;
  void *value;
  unsigned char *bytes;
  size_t length;
};

struct CreationRollbackDependencies {
  void *context;
  const char *(*prepareResponse)(void *context);
  CreationRollbackAddResult (*add)(void *context);
  const char *(*inspect)(void *context, void *exactRef);
  CreationRollbackContentResult (*copyContent)(void *context, void *exactRef);
  const char *(*freeContent)(void *context, void *bytes, size_t length);
  CreationRollbackBufferResult (*createBuffer)(void *context,
                                               const unsigned char *material,
                                               size_t length);
  const char *(*publishBuffer)(void *context, void *value);
  void (*wipeBuffer)(void *context, unsigned char *bytes, size_t length);
  const char *(*deleteExact)(void *context, void *exactRef);
  void (*releaseRef)(void *context, void *ref);
  void (*eraseMaterial)(void *context, unsigned char *material, size_t length);
};

CreationRollbackResult RunCreationRollbackTransaction(
    const std::string &service, unsigned char *material, size_t length,
    CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies);

CreationRollbackResult RetryCreationRollback(
    const std::string &service, CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies);

void ReleaseCreationRollbackDebt(
    CreationRollbackDebt &debt,
    const CreationRollbackDependencies &dependencies);

}
