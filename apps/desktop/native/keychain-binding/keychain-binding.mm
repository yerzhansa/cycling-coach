#define __STDC_WANT_LIB_EXT1__ 1

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <node_api.h>
#include <string.h>

#include <array>
#include <new>
#include <string>

#include "creation-rollback.h"
#include "partition-description.h"

namespace {

constexpr char kTeamIdentifier[] = "FA494ACVTF";
constexpr char kReleaseService[] = "icu.enduragent.desktop";
constexpr char kDevelopmentService[] = "icu.enduragent.desktop.dev";
constexpr char kAccount[] = "credential-encryption-key-v1";
constexpr size_t kKeyBytes = 32;

using enduragent::keychain::CreationRollbackAddResult;
using enduragent::keychain::CreationRollbackBufferResult;
using enduragent::keychain::CreationRollbackContentResult;
using enduragent::keychain::CreationRollbackDebt;
using enduragent::keychain::CreationRollbackDependencies;
using enduragent::keychain::CreationRollbackResult;
using enduragent::keychain::ReleaseCreationRollbackDebt;
using enduragent::keychain::RetryCreationRollback;
using enduragent::keychain::RunCreationRollbackTransaction;

struct BindingState {
  CreationRollbackDebt creationDebt;
};

void EraseBytes(void *bytes, size_t length) {
  if (bytes != nullptr && length > 0)
    memset_s(bytes, length, 0, length);
}

void EraseKey(std::array<unsigned char, kKeyBytes> &material) {
  EraseBytes(material.data(), material.size());
}

CFStringRef String(const char *value) {
  return CFStringCreateWithCString(kCFAllocatorDefault, value,
                                   kCFStringEncodingUTF8);
}

bool Text(napi_env env, const char *value, napi_value &result) {
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) ==
         napi_ok;
}

bool Set(napi_env env, napi_value object, const char *key, napi_value value) {
  return napi_set_named_property(env, object, key, value) == napi_ok;
}

napi_value NapiError(napi_env env) {
  if (napi_throw_error(env, nullptr, "keychain binding response failed") !=
      napi_ok)
    return nullptr;
  return nullptr;
}

bool ResultShell(napi_env env, bool succeeded, napi_value &result) {
  napi_value ok = nullptr;
  return napi_create_object(env, &result) == napi_ok &&
         napi_get_boolean(env, succeeded, &ok) == napi_ok &&
         Set(env, result, "ok", ok);
}

napi_value Failure(napi_env env, const char *code) {
  napi_value result = nullptr;
  napi_value codeValue = nullptr;
  if (!ResultShell(env, false, result) || !Text(env, code, codeValue) ||
      !Set(env, result, "code", codeValue))
    return NapiError(env);
  return result;
}

napi_value CreationFailure(napi_env env, const char *code, bool pending) {
  napi_value result = nullptr;
  napi_value codeValue = nullptr;
  napi_value pendingValue = nullptr;
  if (!ResultShell(env, false, result) || !Text(env, code, codeValue) ||
      !Set(env, result, "code", codeValue) ||
      napi_get_boolean(env, pending, &pendingValue) != napi_ok ||
      !Set(env, result, "creationRollbackPending", pendingValue))
    return NapiError(env);
  return result;
}

napi_value Success(napi_env env) {
  napi_value result = nullptr;
  if (!ResultShell(env, true, result))
    return NapiError(env);
  return result;
}

bool DefaultKeychainLocked() {
  SecKeychainStatus status = 0;
  return SecKeychainGetStatus(nullptr, &status) == errSecSuccess &&
         (status & kSecUnlockStateStatus) == 0;
}

const char *StatusCode(OSStatus status) {
  switch (status) {
  case errSecItemNotFound:
    return "item-not-found";
  case errSecDuplicateItem:
    return "duplicate-item";
  case errSecInteractionNotAllowed:
  case errSecInteractionRequired:
    return DefaultKeychainLocked() ? "keychain-locked" : "uninspectable-item";
  case errSecNotAvailable:
  case errSecNoDefaultKeychain:
    return "uninspectable-item";
  case errSecAuthFailed:
    return "uninspectable-item";
  default:
    return "unknown";
  }
}

bool TrustedHost() {
  SecCodeRef self = nullptr;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess ||
      self == nullptr)
    return false;
  SecRequirementRef requirement = nullptr;
  CFStringRef requirementText = String(
      "identifier \"icu.enduragent.desktop\" and anchor apple generic and "
      "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
      "certificate leaf[subject.OU] = \"FA494ACVTF\"");
  const OSStatus requirementStatus = SecRequirementCreateWithString(
      requirementText, kSecCSDefaultFlags, &requirement);
  CFRelease(requirementText);
  const bool trusted =
      requirementStatus == errSecSuccess && requirement != nullptr &&
      SecCodeCheckValidity(self, kSecCSStrictValidate, requirement) ==
          errSecSuccess;
  if (requirement != nullptr)
    CFRelease(requirement);
  CFRelease(self);
  return trusted;
}

OSStatus InteractionDisabled() {
  return SecKeychainSetUserInteractionAllowed(false);
}

bool AllowedService(const std::string &service) {
  return service == kReleaseService || service == kDevelopmentService;
}

bool ReadService(napi_env env, napi_callback_info info, std::string &service) {
  size_t count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) !=
          napi_ok ||
      count != 1) {
    return false;
  }
  napi_valuetype type;
  if (napi_typeof(env, argument, &type) != napi_ok || type != napi_string)
    return false;
  size_t bytes = 0;
  if (napi_get_value_string_utf8(env, argument, nullptr, 0, &bytes) != napi_ok)
    return false;
  std::string candidate(bytes + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, argument, candidate.data(),
                                 candidate.size(), &written) != napi_ok ||
      written != bytes) {
    return false;
  }
  candidate.resize(bytes);
  service = std::move(candidate);
  return AllowedService(service);
}

OSStatus CopyDefaultKeychain(SecKeychainRef &keychain) {
  keychain = nullptr;
  const OSStatus status = SecKeychainCopyDefault(&keychain);
  if (status != errSecSuccess) {
    if (keychain != nullptr)
      CFRelease(keychain);
    keychain = nullptr;
    return status;
  }
  return keychain == nullptr ? errSecNoDefaultKeychain : errSecSuccess;
}

CFMutableDictionaryRef Query(const std::string &service,
                             SecKeychainRef keychain, bool adding) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (query == nullptr)
    return nullptr;
  CFStringRef serviceValue = String(service.c_str());
  CFStringRef accountValue = String(kAccount);
  if (serviceValue == nullptr || accountValue == nullptr) {
    if (serviceValue != nullptr)
      CFRelease(serviceValue);
    if (accountValue != nullptr)
      CFRelease(accountValue);
    CFRelease(query);
    return nullptr;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, serviceValue);
  CFDictionarySetValue(query, kSecAttrAccount, accountValue);
  CFRelease(serviceValue);
  CFRelease(accountValue);
  if (adding) {
    CFDictionarySetValue(query, kSecUseKeychain, keychain);
  } else {
    const void *values[] = {keychain};
    CFArrayRef searchList = CFArrayCreate(
        kCFAllocatorDefault, values, 1, &kCFTypeArrayCallBacks);
    if (searchList == nullptr) {
      CFRelease(query);
      return nullptr;
    }
    CFDictionarySetValue(query, kSecMatchSearchList, searchList);
    CFRelease(searchList);
  }
  return query;
}

enum class PartitionInspection { kPresent, kAbsent, kUninspectable };

PartitionInspection InspectAccess(SecAccessRef access);

SecAccessRef MakeAccess() {
  SecAccessRef access = nullptr;
  CFStringRef label = String("Enduragent credential encryption key");
  if (SecAccessCreate(label, nullptr, &access) != errSecSuccess ||
      access == nullptr) {
    CFRelease(label);
    return nullptr;
  }
  CFRelease(label);
  CFArrayRef aclList = nullptr;
  if (SecAccessCopyACLList(access, &aclList) != errSecSuccess ||
      aclList == nullptr) {
    CFRelease(access);
    return nullptr;
  }
  const CFIndex count = CFArrayGetCount(aclList);
  CFIndex ownerCount = 0;
  for (CFIndex index = 0; index < count; index += 1) {
    SecACLRef acl = static_cast<SecACLRef>(
        const_cast<void *>(CFArrayGetValueAtIndex(aclList, index)));
    CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
    if (authorizations == nullptr) {
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    const KeychainAclRole role = ClassifyKeychainAcl(authorizations);
    if (role == KeychainAclRole::kPartition ||
        role == KeychainAclRole::kUnsafe) {
      CFRelease(authorizations);
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    CFArrayRef applications = nullptr;
    CFStringRef description = nullptr;
    SecKeychainPromptSelector prompt{};
    if (SecACLCopyContents(acl, &applications, &description, &prompt) !=
        errSecSuccess) {
      if (applications != nullptr)
        CFRelease(applications);
      if (description != nullptr)
        CFRelease(description);
      CFRelease(authorizations);
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    bool acceptable = true;
    if (role == KeychainAclRole::kOwner) {
      ownerCount += 1;
      acceptable = IsExpectedOwnerAcl(authorizations, applications);
    } else {
      acceptable = SecACLSetContents(
                       acl, nullptr,
                       description == nullptr ? CFSTR("") : description,
                       prompt) == errSecSuccess;
    }
    if (applications != nullptr)
      CFRelease(applications);
    if (description != nullptr)
      CFRelease(description);
    CFRelease(authorizations);
    if (!acceptable) {
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
  }
  CFRelease(aclList);
  if (ownerCount != 1) {
    CFRelease(access);
    return nullptr;
  }
  CFStringRef partition =
      String("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
             "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
             "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
             "<plist version=\"1.0\"><dict><key>Partitions</key><array>"
             "<string>teamid:FA494ACVTF</string></array></dict></plist>");
  SecACLRef partitionAcl = nullptr;
  const OSStatus createStatus = SecACLCreateWithSimpleContents(
      access, nullptr, partition, SecKeychainPromptSelector{}, &partitionAcl);
  CFRelease(partition);
  if (createStatus != errSecSuccess || partitionAcl == nullptr) {
    CFRelease(access);
    return nullptr;
  }
  const void *authorization = kSecACLAuthorizationPartitionID;
  CFArrayRef authorizations = CFArrayCreate(kCFAllocatorDefault, &authorization,
                                            1, &kCFTypeArrayCallBacks);
  const OSStatus updateStatus =
      SecACLUpdateAuthorizations(partitionAcl, authorizations);
  CFRelease(authorizations);
  CFRelease(partitionAcl);
  if (updateStatus != errSecSuccess) {
    CFRelease(access);
    return nullptr;
  }
  if (InspectAccess(access) != PartitionInspection::kPresent) {
    CFRelease(access);
    return nullptr;
  }
  return access;
}

PartitionInspection InspectAccess(SecAccessRef access) {
  CFArrayRef aclList = nullptr;
  if (SecAccessCopyACLList(access, &aclList) != errSecSuccess ||
      aclList == nullptr) {
    return PartitionInspection::kUninspectable;
  }
  PartitionInspection result = PartitionInspection::kAbsent;
  KeychainAccessAclInspection inspection{0, 0, true};
  const CFIndex count = CFArrayGetCount(aclList);
  for (CFIndex index = 0; index < count; index += 1) {
    SecACLRef acl = static_cast<SecACLRef>(
        const_cast<void *>(CFArrayGetValueAtIndex(aclList, index)));
    CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
    if (authorizations == nullptr) {
      result = PartitionInspection::kUninspectable;
      break;
    }
    const KeychainAclRole role = ClassifyKeychainAcl(authorizations);
    if (role == KeychainAclRole::kUnrelated) {
      CFRelease(authorizations);
      continue;
    }
    if (role == KeychainAclRole::kUnsafe) {
      IncludeKeychainAcl(inspection, role, authorizations, nullptr, nullptr,
                         SecKeychainPromptSelector{});
      CFRelease(authorizations);
      continue;
    }
    CFArrayRef applications = nullptr;
    CFStringRef description = nullptr;
    SecKeychainPromptSelector prompt{};
    if (SecACLCopyContents(acl, &applications, &description, &prompt) !=
        errSecSuccess) {
      if (applications != nullptr)
        CFRelease(applications);
      if (description != nullptr)
        CFRelease(description);
      CFRelease(authorizations);
      result = PartitionInspection::kUninspectable;
      break;
    }
    IncludeKeychainAcl(inspection, role, authorizations, applications,
                       description, prompt);
    CFRelease(authorizations);
    if (applications != nullptr)
      CFRelease(applications);
    if (description != nullptr)
      CFRelease(description);
  }
  if (result != PartitionInspection::kUninspectable &&
      IsExpectedKeychainAccess(inspection))
    result = PartitionInspection::kPresent;
  CFRelease(aclList);
  return result;
}

PartitionInspection InspectPartition(SecKeychainItemRef item) {
  SecAccessRef access = nullptr;
  if (SecKeychainItemCopyAccess(item, &access) != errSecSuccess ||
      access == nullptr) {
    return PartitionInspection::kUninspectable;
  }
  const PartitionInspection result = InspectAccess(access);
  CFRelease(access);
  return result;
}

struct NativeCreationContext {
  napi_env env;
  CFMutableDictionaryRef attributes;
  napi_value response = nullptr;
  bool napiFailure = false;
};

const char *PrepareCreationResponse(void *value) {
  auto &context = *static_cast<NativeCreationContext *>(value);
  if (!ResultShell(context.env, true, context.response)) {
    context.napiFailure = true;
    return "unknown";
  }
  return nullptr;
}

CreationRollbackAddResult AddCreatedItem(void *value) {
  auto &context = *static_cast<NativeCreationContext *>(value);
  CFTypeRef itemValue = nullptr;
  const OSStatus status = SecItemAdd(context.attributes, &itemValue);
  if (status != errSecSuccess)
    return {StatusCode(status), const_cast<void *>(itemValue), false};
  const bool exact = itemValue != nullptr &&
                     CFGetTypeID(itemValue) == SecKeychainItemGetTypeID();
  return {nullptr, const_cast<void *>(itemValue), exact};
}

const char *InspectCreatedItem(void *, void *value) {
  const PartitionInspection partition = InspectPartition(
      static_cast<SecKeychainItemRef>(value));
  if (partition == PartitionInspection::kPresent)
    return nullptr;
  return partition == PartitionInspection::kAbsent ? "unreadable-item"
                                                    : "uninspectable-item";
}

CreationRollbackContentResult CopyCreatedContent(void *, void *value) {
  UInt32 length = 0;
  void *bytes = nullptr;
  const OSStatus status = SecKeychainItemCopyContent(
      static_cast<SecKeychainItemRef>(value), nullptr, nullptr, &length,
      &bytes);
  return {status == errSecSuccess ? nullptr : StatusCode(status), bytes,
          static_cast<size_t>(length)};
}

const char *FreeCreatedContent(void *, void *bytes, size_t length) {
  EraseBytes(bytes, length);
  return SecKeychainItemFreeContent(nullptr, bytes) == errSecSuccess
             ? nullptr
             : "uninspectable-item";
}

CreationRollbackBufferResult CreateKeyBuffer(void *value,
                                             const unsigned char *material,
                                             size_t length) {
  auto &context = *static_cast<NativeCreationContext *>(value);
  napi_value key = nullptr;
  void *bytes = nullptr;
  if (napi_create_buffer_copy(context.env, length, material, &bytes, &key) !=
      napi_ok) {
    context.napiFailure = true;
    return {"unknown", key, static_cast<unsigned char *>(bytes),
            bytes == nullptr ? 0 : length};
  }
  return {nullptr, key, static_cast<unsigned char *>(bytes), length};
}

const char *PublishKeyBuffer(void *value, void *key) {
  auto &context = *static_cast<NativeCreationContext *>(value);
  if (!Set(context.env, context.response, "key",
           static_cast<napi_value>(key))) {
    context.napiFailure = true;
    return "unknown";
  }
  return nullptr;
}

void WipeKeyBuffer(void *, unsigned char *bytes, size_t length) {
  EraseBytes(bytes, length);
}

const char *DeleteCreatedItem(void *, void *value) {
  const OSStatus status =
      SecKeychainItemDelete(static_cast<SecKeychainItemRef>(value));
  return status == errSecSuccess ? nullptr : StatusCode(status);
}

void ReleaseCreatedRef(void *, void *value) {
  CFRelease(static_cast<CFTypeRef>(value));
}

void EraseCreatedMaterial(void *, unsigned char *material, size_t length) {
  EraseBytes(material, length);
}

CreationRollbackDependencies NativeCreationDependencies(void *context) {
  return {context,
          PrepareCreationResponse,
          AddCreatedItem,
          InspectCreatedItem,
          CopyCreatedContent,
          FreeCreatedContent,
          CreateKeyBuffer,
          PublishKeyBuffer,
          WipeKeyBuffer,
          DeleteCreatedItem,
          ReleaseCreatedRef,
          EraseCreatedMaterial};
}

bool GetBindingState(napi_env env, BindingState *&state) {
  void *value = nullptr;
  if (napi_get_instance_data(env, &value) != napi_ok || value == nullptr)
    return false;
  state = static_cast<BindingState *>(value);
  return true;
}

void FinalizeBindingState(napi_env, void *value, void *) {
  auto *state = static_cast<BindingState *>(value);
  if (state == nullptr)
    return;
  const CreationRollbackDependencies dependencies =
      NativeCreationDependencies(nullptr);
  ReleaseCreationRollbackDebt(state->creationDebt, dependencies);
  delete state;
}

const char *ReadinessFailure() {
  const OSStatus interactionStatus = InteractionDisabled();
  if (interactionStatus != errSecSuccess)
    return StatusCode(interactionStatus);
  static const bool trusted = TrustedHost();
  return trusted ? nullptr : "not-team-signed";
}

napi_value Probe(napi_env env, napi_callback_info) {
  const char *refusal = ReadinessFailure();
  if (refusal != nullptr)
    return Failure(env, refusal);
  napi_value result = Success(env);
  napi_value identifier = nullptr;
  if (result == nullptr || !Text(env, kTeamIdentifier, identifier) ||
      !Set(env, result, "teamIdentifier", identifier))
    return NapiError(env);
  return result;
}

napi_value ReadKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  const char *refusal = ReadinessFailure();
  if (refusal != nullptr)
    return Failure(env, refusal);
  BindingState *state = nullptr;
  if (!GetBindingState(env, state))
    return Failure(env, "unknown");
  const CreationRollbackResult retry = RetryCreationRollback(
      service, state->creationDebt, NativeCreationDependencies(nullptr));
  if (!retry.ok)
    return Failure(env, retry.code);
  SecKeychainRef keychain = nullptr;
  const OSStatus defaultStatus = CopyDefaultKeychain(keychain);
  if (defaultStatus != errSecSuccess)
    return Failure(env, StatusCode(defaultStatus));
  CFMutableDictionaryRef query = Query(service, keychain, false);
  CFRelease(keychain);
  if (query == nullptr)
    return Failure(env, "unknown");
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef itemValue = nullptr;
  const OSStatus status = SecItemCopyMatching(query, &itemValue);
  CFRelease(query);
  if (status != errSecSuccess)
    return Failure(env, StatusCode(status));
  if (itemValue == nullptr ||
      CFGetTypeID(itemValue) != SecKeychainItemGetTypeID()) {
    if (itemValue != nullptr)
      CFRelease(itemValue);
    return Failure(env, "unreadable-item");
  }
  SecKeychainItemRef item =
      static_cast<SecKeychainItemRef>(const_cast<void *>(itemValue));
  const PartitionInspection partition = InspectPartition(item);
  if (partition != PartitionInspection::kPresent) {
    CFRelease(itemValue);
    return Failure(env, partition == PartitionInspection::kAbsent
                            ? "unreadable-item"
                            : "uninspectable-item");
  }
  UInt32 contentLength = 0;
  void *contentBytes = nullptr;
  const OSStatus contentStatus = SecKeychainItemCopyContent(
      item, nullptr, nullptr, &contentLength, &contentBytes);
  CFRelease(itemValue);
  if (contentStatus != errSecSuccess) {
    EraseBytes(contentBytes, static_cast<size_t>(contentLength));
    if (contentBytes != nullptr)
      SecKeychainItemFreeContent(nullptr, contentBytes);
    return Failure(env, StatusCode(contentStatus));
  }
  if (contentBytes == nullptr || contentLength != kKeyBytes) {
    EraseBytes(contentBytes, static_cast<size_t>(contentLength));
    OSStatus freeStatus = errSecSuccess;
    if (contentBytes != nullptr)
      freeStatus = SecKeychainItemFreeContent(nullptr, contentBytes);
    return Failure(env, freeStatus == errSecSuccess ? "unreadable-item"
                                                    : "uninspectable-item");
  }
  napi_value key = nullptr;
  void *keyBytes = nullptr;
  const napi_status bufferStatus = napi_create_buffer_copy(
      env, kKeyBytes, contentBytes, &keyBytes, &key);
  EraseBytes(contentBytes, static_cast<size_t>(contentLength));
  const OSStatus freeStatus =
      SecKeychainItemFreeContent(nullptr, contentBytes);
  if (bufferStatus != napi_ok || freeStatus != errSecSuccess) {
    EraseBytes(keyBytes, keyBytes == nullptr ? 0 : kKeyBytes);
    return bufferStatus != napi_ok ? NapiError(env)
                                   : Failure(env, "uninspectable-item");
  }
  napi_value response = Success(env);
  if (response == nullptr || !Set(env, response, "key", key)) {
    EraseBytes(keyBytes, kKeyBytes);
    return NapiError(env);
  }
  return response;
}

napi_value CreateKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return CreationFailure(env, "unknown", false);
  const char *refusal = ReadinessFailure();
  if (refusal != nullptr)
    return CreationFailure(env, refusal, false);
  BindingState *state = nullptr;
  if (!GetBindingState(env, state))
    return CreationFailure(env, "unknown", false);
  const CreationRollbackResult retry = RetryCreationRollback(
      service, state->creationDebt, NativeCreationDependencies(nullptr));
  if (!retry.ok)
    return CreationFailure(env, retry.code,
                           retry.creationRollbackPending);
  SecKeychainRef keychain = nullptr;
  const OSStatus defaultStatus = CopyDefaultKeychain(keychain);
  if (defaultStatus != errSecSuccess)
    return CreationFailure(env, StatusCode(defaultStatus), false);
  std::array<unsigned char, kKeyBytes> material{};
  if (SecRandomCopyBytes(kSecRandomDefault, material.size(), material.data()) !=
      errSecSuccess) {
    CFRelease(keychain);
    EraseKey(material);
    return CreationFailure(env, "unknown", false);
  }
  SecAccessRef access = MakeAccess();
  if (access == nullptr) {
    CFRelease(keychain);
    EraseKey(material);
    return CreationFailure(env, "unknown", false);
  }
  CFMutableDictionaryRef attributes = Query(service, keychain, true);
  CFRelease(keychain);
  if (attributes == nullptr) {
    CFRelease(access);
    EraseKey(material);
    return CreationFailure(env, "unknown", false);
  }
  CFDataRef data = CFDataCreateWithBytesNoCopy(
      kCFAllocatorDefault, material.data(), material.size(), kCFAllocatorNull);
  if (data == nullptr) {
    CFRelease(attributes);
    CFRelease(access);
    EraseKey(material);
    return CreationFailure(env, "unknown", false);
  }
  CFDictionarySetValue(attributes, kSecValueData, data);
  CFDictionarySetValue(attributes, kSecAttrAccess, access);
  CFDictionarySetValue(attributes, kSecReturnRef, kCFBooleanTrue);
  NativeCreationContext context{env, attributes};
  const CreationRollbackResult result = RunCreationRollbackTransaction(
      service, material.data(), material.size(), state->creationDebt,
      NativeCreationDependencies(&context));
  CFRelease(attributes);
  CFRelease(data);
  CFRelease(access);
  if (result.ok)
    return context.response;
  return CreationFailure(env, result.code, result.creationRollbackPending);
}

napi_value RetryCreatedKeyRollback(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  const char *refusal = ReadinessFailure();
  if (refusal != nullptr)
    return Failure(env, refusal);
  BindingState *state = nullptr;
  if (!GetBindingState(env, state))
    return Failure(env, "unknown");
  const CreationRollbackResult retry = RetryCreationRollback(
      service, state->creationDebt, NativeCreationDependencies(nullptr));
  return retry.ok ? Success(env) : Failure(env, retry.code);
}

napi_value DeleteKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  const char *refusal = ReadinessFailure();
  if (refusal != nullptr)
    return Failure(env, refusal);
  BindingState *state = nullptr;
  if (!GetBindingState(env, state))
    return Failure(env, "unknown");
  if (state->creationDebt.pending)
    return Failure(env, "uninspectable-item");
  SecKeychainRef keychain = nullptr;
  const OSStatus defaultStatus = CopyDefaultKeychain(keychain);
  if (defaultStatus != errSecSuccess)
    return Failure(env, StatusCode(defaultStatus));
  CFMutableDictionaryRef query = Query(service, keychain, false);
  CFRelease(keychain);
  if (query == nullptr)
    return Failure(env, "unknown");
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef itemValue = nullptr;
  OSStatus status = SecItemCopyMatching(query, &itemValue);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound)
    return Failure(env, StatusCode(status));
  if (status == errSecSuccess &&
      (itemValue == nullptr ||
       CFGetTypeID(itemValue) != SecKeychainItemGetTypeID())) {
    if (itemValue != nullptr)
      CFRelease(itemValue);
    return Failure(env, "unreadable-item");
  }
  if (status == errSecSuccess) {
    SecKeychainItemRef item =
        static_cast<SecKeychainItemRef>(const_cast<void *>(itemValue));
    const PartitionInspection partition = InspectPartition(item);
    if (partition != PartitionInspection::kPresent) {
      CFRelease(itemValue);
      return Failure(env, partition == PartitionInspection::kAbsent
                              ? "unreadable-item"
                              : "uninspectable-item");
    }
    status = SecKeychainItemDelete(item);
    CFRelease(itemValue);
    if (status != errSecSuccess)
      return Failure(env, StatusCode(status));
  }
  napi_value response = Success(env);
  napi_value deleted = nullptr;
  if (response == nullptr ||
      napi_get_boolean(env, status == errSecSuccess, &deleted) != napi_ok ||
      !Set(env, response, "deleted", deleted))
    return NapiError(env);
  return response;
}

}

NAPI_MODULE_INIT() {
  auto *state = new (std::nothrow) BindingState();
  if (state == nullptr)
    return NapiError(env);
  if (napi_set_instance_data(env, state, FinalizeBindingState, nullptr) !=
      napi_ok) {
    delete state;
    return NapiError(env);
  }
  const napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"readKey", nullptr, ReadKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"createKey", nullptr, CreateKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"retryCreatedKeyRollback", nullptr, RetryCreatedKeyRollback, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"deleteKey", nullptr, DeleteKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  if (napi_define_properties(
          env, exports, sizeof(properties) / sizeof(properties[0]),
          properties) != napi_ok)
    return NapiError(env);
  return exports;
}
