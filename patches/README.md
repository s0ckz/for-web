# Patches

## mdui@2.1.3.patch

Guards three unguarded reads of `this.inputRef.value.validationMessage` in
`mdui`'s `<mdui-text-field>` (`components/text-field/index.js`, lines
~196/382/541) with optional chaining (`?.`). `lit-html`'s `ref` directive sets
the ref to `undefined` in `disconnected()`; a validated (`invalid === true`)
text field that gets re-parented or animated out (e.g. Solid/`solid-motionone`
transitions, such as the login → app screen) can render once while
disconnected, with `inputRef.value === undefined`, throwing
`TypeError: Cannot read properties of undefined (reading 'validationMessage')`.

mdui 2.1.5 (the latest published release as of this patch) still has the same
unguarded lines, so upgrading does not fix this — only a patch does.

If mdui is bumped in the future, re-run `pnpm patch mdui@<new-version>` and
re-check whether these three lines (or their equivalents) still need the
optional-chaining guard before regenerating the patch.
