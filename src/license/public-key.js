/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 必须与仓库外的签发私钥（默认 ~/.supertime/license-private.pem）同源。
 */
const PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEArcsPyNpQ6e2R9RNqe5QfQFjO4pFjwCj9g2ZN6ddn2R8=\n-----END PUBLIC KEY-----\n"

module.exports = { PUBLIC_KEY_PEM }
