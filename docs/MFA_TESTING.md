# Admin MFA Validation

VoxHF owner MFA is optional. Adding the first passkey enables it for that owner;
removing the last passkey disables it. The relay never forces enrollment.

## Automated Preflight

After deploying a release, verify the public admin surface:

```powershell
npm.cmd run relay:mfa:preflight -- https://relay.example.com
```

The command checks HTTPS security headers, the admin API, and the self-hosted
WebAuthn browser client. It does not emulate a real authenticator.

## Real Authenticator Matrix

Run this sequence once with every platform the owner intends to use:

| Platform | Authenticator |
| --- | --- |
| Windows | Windows Hello or a security key |
| macOS | Touch ID or a security key |
| iPhone/iPad | Face ID or Touch ID |

1. Sign in to `/admin` with the owner password.
2. Open **Security**, enter the current password, and add a named passkey.
3. Save the recovery codes outside the relay host; they are shown once.
4. Sign out, sign in again, and complete the passkey prompt.
5. Sign out and consume one recovery code instead. Confirm that the same code
   fails when reused.
6. Regenerate recovery codes and confirm that an older unused code no longer
   works.
7. Remove one passkey and verify that another registered passkey still works.
8. Remove the last passkey and confirm that password-only login works again.
9. Re-enable MFA, then run break-glass owner recovery. Confirm that existing
   admin sessions are revoked and MFA is cleared.

Record browser and operating-system versions with the result. Passkeys are
bound to the deployed WebAuthn RP ID, so changing the relay domain requires new
passkey enrollment.
