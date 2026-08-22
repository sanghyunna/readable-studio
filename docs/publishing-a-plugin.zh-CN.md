# 发布 Readable Studio 插件

Readable Studio registry v1 复用 GitHub 作为后端。CLI 是 canonical workflow；
产品 UI 和 agent 创建流程只是包装这些命令。

## 1. 创建

```bash
readable plugin scaffold --id vendor/plugin-name --title "Plugin name" --out ./plugins/community
```

公开 registry ID 必须是 `vendor/plugin-name`。生成的 `readable-studio.json`
需要包含 `plugin.repo`，指向插件的源码仓库或源码子目录。

## 2. 校验和打包

```bash
readable plugin validate ./plugins/community/plugin-name
readable plugin pack ./plugins/community/plugin-name --out ./dist
```

registry 接受任何能通过 validate 和 pack 的插件。源码仓库不需要特殊结构，
只需要 `SKILL.md` 和 `readable-studio.json`。

## 3. 登录

```bash
readable plugin login
readable plugin whoami --json
```

这两个命令包装 GitHub CLI。token 留在 `gh`，Readable Studio 不保存 GitHub
凭据。

## 4. 发布

```bash
readable plugin publish vendor/plugin-name --to readable-studio --repo https://github.com/vendor/plugin-name
```

v1 会打开 GitHub registry review flow。发布 payload 包含插件 ID、版本、
源码仓库、能力摘要、包 digest 和 registry entry path。维护者在 registry 变更中
显式更新 catalog：

```bash
readable plugin publish vendor/plugin-name --to marketplace-json \
  --catalog plugins/registry/community/readable-studio-marketplace.json \
  --repo https://github.com/vendor/plugin-name
```

## 5. 从 registry 安装

```bash
readable marketplace refresh official
readable plugin install vendor/plugin-name
readable plugin info vendor/plugin-name --json
```

安装记录会保留 marketplace provenance、resolved source、manifest digest 和
archive integrity。`official` / `trusted` 来源默认安装为 trusted；`restricted`
来源仍然保持 restricted，直到用户主动授权。

## 6. Yank 版本

```bash
readable plugin yank vendor/plugin-name@1.0.0 --reason "Security issue"
```

Yank 不删除元数据和包。新安装会拒绝 yanked version；已经存在的精确 lockfile
重放可以在 integrity 匹配且 archive 仍可访问时带警告继续。
