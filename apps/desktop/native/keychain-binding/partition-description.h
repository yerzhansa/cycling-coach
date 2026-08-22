#pragma once

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecACL.h>

bool IsExpectedPartitionDescription(CFStringRef description);
bool AreExpectedPartitionDescriptions(CFArrayRef descriptions);
bool IsExpectedPartitionAcl(CFArrayRef authorizations, CFArrayRef applications,
                            CFStringRef description,
                            SecKeychainPromptSelector prompt);
