# Digital signatures

Elanero signs PDFs with a digital signature in the **PAdES** format, at the **B-B** level, and
optionally with a trusted timestamp (**B-T**). A digital signature shows who signed and proves that
the document has not changed since. Signatures are on the **Protect** ribbon tab, in the **Sign**
group: **Place**, **Sign** and **Request**.

!!! warning "Read the limits first"
    Signature checks work offline and don't check certificate revocation, so a valid result is not a
    guarantee of legal status. See [Limits](#limits) at the end of this page.

## What you need

A signing certificate, from one of these sources:

| Source | What you need |
| --- | --- |
| **Certificate file** (`.pfx` or `.p12`) | The file and its password. |
| **Windows certificate store** | A certificate installed in Windows. USB tokens and smart cards also work here when their vendor software has installed them into Windows. |
| **USB token or smart card** through a PKCS#11 module | The vendor's PKCS#11 module (a 64-bit `.dll`, usually in Program Files), and the token's PIN. |

## Place a visible signature

A visible signature is a box on the page with the signer's name, the date and an optional reason and
location.

1. Click **Place** (**Edit ▸ Place Signature**). Drag a box on the page where the signature should
   appear.
2. Click **Sign** (see below), and choose the signature field you placed.

## Sign a document

1. Click **Sign** (**Tools ▸ Sign Document**).
2. Choose the signature field to sign, or choose **New invisible signature**. An invisible signature
   draws nothing on the page; it only records the signature in the file.
3. Choose the certificate source and the certificate. For a certificate file, enter its password. For
   a token, see [PIN safety](#pin-safety).
4. Optionally, turn on **Add a trusted timestamp** and enter the address of a timestamp server. Only
   a hash of the signature is sent to that server. No server is set by default, and the timestamp is
   off unless you turn it on.
5. Click **Sign**. Elanero asks where to save the signed copy. The signed copy is saved as a new file,
   and the original isn't changed.

Elanero checks the signed file after saving. A document that already has signatures keeps them; a new
signature is added after them, so earlier signatures stay valid.

## Request signatures from other people

**Request** (**Tools ▸ Request Signatures**) prepares a document for several people to sign.

1. Save the document first. Then click **Request** in the **Sign** group.
2. Drag a box on the page for each signer. The banner says "Drag a box for each signer, then press
   Done".
3. After each box, enter the signer's name (as it should appear in the signature) and, optionally,
   their email address. Click **Add Another Signer** to place the next signer's box, or **Finish** to
   close the form.
4. Press **Done** (or **Esc**) when every signer has a box. Choose where to save the copy; its name
   ends in `-for-signature.pdf` when Elanero suggests one.
5. Attach that file to an email and send it yourself. Elanero does not send email, track who signed,
   or send reminders.

The requested signature boxes have not yet completed the Acrobat interoperability check (see
[Limits](#limits)). Test the file with the reader your signers use before you rely on the process.

## Check the signatures in a document

Open the **Signatures** panel from the navigation panels on the left side. It shows, for each signature:

- whether the signed content is intact, and whether it is changed after signing
- whether the certificate is trusted by Windows
- the signing time, and any timestamp
- the certificate details (who issued it and who it belongs to)
- the signed revisions of the document

The check runs on your computer. Elanero doesn't contact any server to do it. On Windows it reads the
certificates your PC already trusts, from the Windows certificate stores, and never opens a private
key.

## PIN safety

Tokens and smart cards lock after too many wrong PINs, so Elanero is careful with the PIN:

- Listing the certificates on a token never sends a PIN. Click **List** to read the tokens first.
- The PIN is sent once, to the one token you chose, when you click the button to log in and sign.
  Elanero does not retry it.
- If the token shows that it has recorded a wrong PIN, or that it is locked, Elanero stops and tells
  you. On its last try, Elanero asks you to confirm first, because one more wrong PIN locks the token.
- Elanero never stores a PIN or a certificate password, and never writes them to the log.
- Some tokens ask for the PIN on their own keypad or in their software. Enter it there.

!!! note
    If Elanero is closed while a Windows or token PIN prompt is open, the prompt keeps waiting until
    it is answered or dismissed.

## Limits

- Signature checks work offline. They don't check certificate revocation lists or fetch certificates,
  so a valid result doesn't prove that a certificate hasn't been revoked since.
- Trust and integrity results are not a guarantee of legal status.
- Certificates from a token need the vendor's PKCS#11 module, and not every token has been tested.
- RSA-PSS signatures and long-term validation data (B-LT and B-LTA) are not supported.
- Requested signature boxes have not yet been checked in every version of Adobe Acrobat.
