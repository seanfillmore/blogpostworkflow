# Add the Instagram line to Shopify's Shipping confirmation email

The email with tracking is sent by **Shopify**, not Klaviyo. Shopify's API cannot edit
notification templates, so this is a paste in the admin. About 5 minutes.

## 1. Back up the current template first

1. Shopify Admin > **Settings** > **Notifications** > **Customer notifications**.
2. Under *Shipping*, click **Shipping confirmation**, then **Edit code**.
3. Select all the code in the **Email body (HTML)** box, copy it, and paste it into a
   text file on your computer (`shipping-confirmation-backup-2026-11-04.html`). This is
   your revert copy.

## 2. Find the anchor

In the **Email body (HTML)** box, use the browser's find (Cmd+F) for:

```
<table class="row footer">
```

That table is the footer ("If you have any questions, reply to this email..."). It comes
after the shipped items and the tracking button in Shopify's default template.

- **Found it:** put your cursor at the very start of that line (before `<table`) and
  press Enter to make an empty line above it. Paste there.
- **Not found** (the template was customized): search for `If you have any questions`
  instead, and paste directly above the `<table` that line sits inside.

Do not paste inside the `{% if fulfillment.tracking_numbers %}` block or inside the
items loop; the anchor above is outside both.

## 3. Paste this snippet

```html
<table class="row section">
  <tr>
    <td class="section__cell">
      <center>
        <table class="container">
          <tr>
            <td>
              <p style="color:#777;line-height:150%;font-size:16px;margin:0 0 8px;">While your order is on its way: we post quick how-tos, real customer reviews and a new creator video every day on Instagram. Follow along at @realskincare_com.</p>
              <p style="line-height:150%;font-size:16px;margin:0;"><a href="https://www.instagram.com/realskincare_com/" style="color:{{ shop.email_accent_color | default: '#000000' }};font-weight:bold;text-decoration:underline;">Follow us on Instagram</a></p>
            </td>
          </tr>
        </table>
      </center>
    </td>
  </tr>
</table>
```

It reuses the classes (`row section`, `section__cell`, `container`) that Shopify's
default template already styles, so it lines up with the sections above it. The inline
styles match Shopify's default paragraph text (grey `#777`, 16px) and use your store's
email accent color for the link. Nothing else in the template changes.

## 4. Preview and test

1. Click **Preview** (top of the editor) and scroll to the bottom: the line and link
   should sit between the shipped items and the footer.
2. Click **Save**.
3. Back on the Shipping confirmation page, click **Send test email**. It goes to the
   store owner's email. Open it on your phone, check the layout, and tap the link to
   confirm it opens @realskincare_com.

## 5. Revert, if needed

- Easiest: open **Edit code** again, delete the snippet (from `<table class="row section">`
  to its closing `</table>`), and **Save**.
- Or paste back the full backup from step 1 and **Save**.
- Avoid **Revert to default** unless you mean it: it also throws away any other
  customization in this template.
