#include "partition-description.h"

#include <cstring>

namespace {

bool Equal(const char *left, const char *right) {
  return std::strcmp(left, right) == 0;
}

CFStringRef String(const char *value) {
  return CFStringCreateWithBytes(
      kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(value),
      static_cast<CFIndex>(std::strlen(value)), kCFStringEncodingUTF8, false);
}

int DescriptionStatus(int argumentCount, char **arguments) {
  CFMutableArrayRef descriptions = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (descriptions == nullptr)
    return 2;
  for (int index = 2; index < argumentCount; index += 1) {
    CFStringRef description = String(arguments[index]);
    if (description == nullptr) {
      CFRelease(descriptions);
      return 2;
    }
    CFArrayAppendValue(descriptions, description);
    CFRelease(description);
  }
  const bool acceptable = AreExpectedPartitionDescriptions(descriptions);
  CFRelease(descriptions);
  return acceptable ? 0 : 1;
}

int AclStatus(int argumentCount, char **arguments) {
  if (argumentCount != 6)
    return 2;
  CFMutableArrayRef authorizations = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (authorizations == nullptr)
    return 2;
  if (Equal(arguments[2], "exact") || Equal(arguments[2], "extra"))
    CFArrayAppendValue(authorizations, kSecACLAuthorizationPartitionID);
  if (Equal(arguments[2], "wrong") || Equal(arguments[2], "extra"))
    CFArrayAppendValue(authorizations, kSecACLAuthorizationDecrypt);
  if (!Equal(arguments[2], "exact") && !Equal(arguments[2], "wrong") &&
      !Equal(arguments[2], "extra")) {
    CFRelease(authorizations);
    return 2;
  }
  CFMutableArrayRef applications = nullptr;
  if (Equal(arguments[3], "empty") || Equal(arguments[3], "populated")) {
    applications = CFArrayCreateMutable(kCFAllocatorDefault, 0,
                                        &kCFTypeArrayCallBacks);
    if (applications == nullptr) {
      CFRelease(authorizations);
      return 2;
    }
    if (Equal(arguments[3], "populated"))
      CFArrayAppendValue(applications, CFSTR("application"));
  } else if (!Equal(arguments[3], "null")) {
    CFRelease(authorizations);
    return 2;
  }
  SecKeychainPromptSelector prompt{};
  if (Equal(arguments[4], "nonzero"))
    prompt = kSecKeychainPromptUnsigned;
  else if (!Equal(arguments[4], "zero")) {
    if (applications != nullptr)
      CFRelease(applications);
    CFRelease(authorizations);
    return 2;
  }
  CFStringRef description = String(arguments[5]);
  if (description == nullptr) {
    if (applications != nullptr)
      CFRelease(applications);
    CFRelease(authorizations);
    return 2;
  }
  const bool acceptable = IsExpectedPartitionAcl(
      authorizations, applications, description, prompt);
  CFRelease(description);
  if (applications != nullptr)
    CFRelease(applications);
  CFRelease(authorizations);
  return acceptable ? 0 : 1;
}

}

int main(int argumentCount, char **arguments) {
  if (argumentCount < 2)
    return 2;
  if (Equal(arguments[1], "descriptions"))
    return DescriptionStatus(argumentCount, arguments);
  if (Equal(arguments[1], "acl"))
    return AclStatus(argumentCount, arguments);
  return 2;
}
