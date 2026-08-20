# Agent Note: 首次连接主机密钥 TOFU(弹窗确认后信任保存)
Status: implemented

## Problem
- 原 hostVerifier 对 unknown/mismatch 一律硬拒绝,用户新加主机首次「测试连接」必失败,体验断裂。

## Decision
- **TOFU 弹窗版**(不做 accept-new 自动接受):ssh-core 新增 `HOST_KEY_UNKNOWN_STAGE`(host-key-unknown);首次连接未知主机密钥时,结构化上报(不硬拒)stage + SHA256 指纹(`sshKeyFingerprint`)+ rawKeyBase64 + keyType(`sshKeyTypeFromBlob`);客户端弹信任对话框展示 主机/host:port、密钥类型、SHA256 指纹(等宽 + 一键复制),按钮【信任并保存】/【取消】;确认 → `ssh.trustHostKey(hostId, rawKeyBase64, fingerprint)` 追加 known_hosts → 自动重试原操作(测试连接/目录浏览);取消仅关闭。
- mismatch 维持硬拒绝(v1 不提供「仍然信任」覆盖)。dev/test 保留既有 `acceptNew` 开关(TOFU 走用户确认)。
- Typert 客户端 descriptors 增 `trustHostKey(['hostId','rawKeyBase64','fingerprint'])`(host/client 双侧,顺序一致通过对齐断言)。

## Alternatives considered
- accept-new 自动接受(现状变体):无信任依据,不安全 → 不做。

## Consequences
- 未知→信任→重连成功全程通过(真机指纹/类型解析 vs `ssh-keygen -lf` 三级 ALL_MATCH)。
- 指纹校验 + `appendKnownHost` 幂等(trustHostKey 拒不匹配指纹,幂等追加)。

## 出处
- archived/a-series-log.md A.34(TOFU 弹窗实施)。
- 本仓库 src/ssh-core.js(HOST_KEY_UNKNOWN_STAGE/sshKeyFingerprint/sshKeyTypeFromBlob/verifyHostKey/appendKnownHost)、src/remote.js trustHostKey、lib/typert-contribution.js、client.js TrustHostKeyModal。
