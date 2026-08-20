import Foundation
import Security

let requiredTeamIdentifier = "FA494ACVTF"
let keyAccount = "credential-encryption-key-v1"
let allowedServices: Set<String> = ["icu.enduragent.desktop", "icu.enduragent.desktop.dev"]
let keyByteCount = 32
let accessLabel = "Enduragent credential encryption key"
let partitionMarker = "teamid:FA494ACVTF"
let partitionPlist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Partitions</key><array><string>teamid:FA494ACVTF</string></array></dict></plist>
"""

SecKeychainSetUserInteractionAllowed(false)

func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
        let line = String(data: data, encoding: .utf8)
  else {
    print("{\"ok\":false,\"code\":\"unknown\"}")
    return
  }
  print(line)
}

func succeed(_ payload: [String: Any]) -> Never {
  emit(payload)
  exit(0)
}

func fail(_ code: String) -> Never {
  emit(["ok": false, "code": code])
  exit(0)
}

func mapStatus(_ status: OSStatus) -> String {
  switch status {
  case errSecItemNotFound:
    return "item-not-found"
  case errSecDuplicateItem:
    return "duplicate-item"
  case errSecInteractionNotAllowed, errSecInteractionRequired, errSecNotAvailable:
    return "keychain-locked"
  case errSecAuthFailed:
    return "unreadable-item"
  default:
    return "unknown"
  }
}

func signedTeamIdentifier() -> String? {
  var code: SecCode?
  guard SecCodeCopySelf(SecCSFlags(rawValue: 0), &code) == errSecSuccess, let code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess,
        let staticCode
  else { return nil }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(
    staticCode,
    SecCSFlags(rawValue: kSecCSSigningInformation),
    &information
  ) == errSecSuccess,
    let attributes = information as? [String: Any]
  else { return nil }
  return attributes[kSecCodeInfoTeamIdentifier as String] as? String
}

func baseQuery(_ service: String) -> [String: Any] {
  return [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: keyAccount,
  ]
}

func makeAccess() -> SecAccess? {
  var access: SecAccess?
  guard SecAccessCreate(accessLabel as CFString, nil, &access) == errSecSuccess, let access else {
    return nil
  }
  var aclList: CFArray?
  guard SecAccessCopyACLList(access, &aclList) == errSecSuccess else { return nil }
  for acl in (aclList as? [SecACL]) ?? [] {
    var applications: CFArray?
    var description: CFString?
    var prompt = SecKeychainPromptSelector()
    guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess else {
      continue
    }
    guard SecACLSetContents(acl, nil, description ?? "" as CFString, prompt) == errSecSuccess else {
      return nil
    }
  }
  var partitionACL: SecACL?
  guard SecACLCreateWithSimpleContents(
    access,
    nil,
    partitionPlist as CFString,
    SecKeychainPromptSelector(rawValue: 0),
    &partitionACL
  ) == errSecSuccess,
    let partitionACL
  else { return nil }
  guard SecACLUpdateAuthorizations(
    partitionACL,
    [kSecACLAuthorizationPartitionID] as CFArray
  ) == errSecSuccess else { return nil }
  return access
}

func carriesPartitionEntry(_ item: SecKeychainItem) -> Bool {
  var access: SecAccess?
  guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess, let access else { return false }
  var aclList: CFArray?
  guard SecAccessCopyACLList(access, &aclList) == errSecSuccess else { return false }
  for acl in (aclList as? [SecACL]) ?? [] {
    let authorizations = SecACLCopyAuthorizations(acl) as? [String] ?? []
    guard authorizations.contains(kSecACLAuthorizationPartitionID as String) else { continue }
    var applications: CFArray?
    var description: CFString?
    var prompt = SecKeychainPromptSelector()
    guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess else {
      continue
    }
    if let text = description as String?, text.contains(partitionMarker) { return true }
  }
  return false
}

func readKey(_ service: String) -> Never {
  var query = baseQuery(service)
  query[kSecReturnData as String] = true
  query[kSecReturnRef as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess else { fail(mapStatus(status)) }
  guard let attributes = result as? [String: Any],
        let data = attributes[kSecValueData as String] as? Data,
        data.count == keyByteCount,
        let reference = attributes[kSecValueRef as String]
  else { fail("unreadable-item") }
  let candidate = reference as CFTypeRef
  guard CFGetTypeID(candidate) == SecKeychainItemGetTypeID() else { fail("unreadable-item") }
  let item = unsafeBitCast(candidate, to: SecKeychainItem.self)
  guard carriesPartitionEntry(item) else { fail("unreadable-item") }
  succeed(["ok": true, "op": "read-key", "key": data.base64EncodedString()])
}

func createKey(_ service: String) -> Never {
  var material = [UInt8](repeating: 0, count: keyByteCount)
  guard SecRandomCopyBytes(kSecRandomDefault, keyByteCount, &material) == errSecSuccess else {
    fail("unknown")
  }
  guard let access = makeAccess() else { fail("unknown") }
  let data = Data(material)
  var attributes = baseQuery(service)
  attributes[kSecValueData as String] = data
  attributes[kSecAttrAccess as String] = access
  let status = SecItemAdd(attributes as CFDictionary, nil)
  guard status == errSecSuccess else { fail(mapStatus(status)) }
  succeed(["ok": true, "op": "create-key", "key": data.base64EncodedString()])
}

func deleteKey(_ service: String) -> Never {
  let status = SecItemDelete(baseQuery(service) as CFDictionary)
  if status == errSecSuccess { succeed(["ok": true, "op": "delete-key", "deleted": true]) }
  if status == errSecItemNotFound { succeed(["ok": true, "op": "delete-key", "deleted": false]) }
  fail(mapStatus(status))
}

guard let line = readLine(strippingNewline: true),
      let payload = line.data(using: .utf8),
      let request = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
      let operation = request["op"] as? String
else { fail("unknown") }

guard signedTeamIdentifier() == requiredTeamIdentifier else { fail("not-team-signed") }

if operation == "probe" {
  succeed(["ok": true, "op": "probe", "teamIdentifier": requiredTeamIdentifier])
}

guard let service = request["service"] as? String, allowedServices.contains(service) else {
  fail("unknown")
}

switch operation {
case "read-key":
  readKey(service)
case "create-key":
  createKey(service)
case "delete-key":
  deleteKey(service)
default:
  fail("unknown")
}
