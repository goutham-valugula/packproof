# PackProof

**Keep each shipment’s packing record together.** PackProof is a local-first packing workflow for small warehouse teams: import an order list, verify packed quantities across multiple lots, attach shipment photos, and confirm a dispatch check—without replacing an inventory system.

**Live app:** https://goutham-valugula.github.io/packproof/

## The problem signal

A small-business warehouse operator described shipping 25–30 pallets a week while manually recording each order’s quantities and lot numbers in Google Sheets and keeping shipment photos on a separate phone. When customers disputed missing items, the evidence was split across those tools. The post asked for per-order scanning and an exportable report: [Inventory Management System — r/smallbusiness](https://www.reddit.com/r/smallbusiness/comments/1udj3wa/inventory_management_system/).

Inventory products already offer barcode and lot tracking. For example, [HandiFox](https://www.handifox.com/pricing) combines mobile barcode workflows with order fulfillment and lot tracking, and [Invenva](https://invenva.com/) offers stock movement, order checklists, barcode scanning, photos, and reports. PackProof takes a narrower approach: capture a per-shipment packing check and photo set locally, then make a printable record. It does not maintain stock balances or sync with those systems. This is an initial release based on a problem report, not proof of broad market demand.

## Use it

Open the [live app](https://goutham-valugula.github.io/packproof/) or `index.html` in a modern browser. Create a shipment and import a CSV order list, or add lines manually. The CSV needs a header row and an item identifier (`sku` or `name`) plus a requested quantity (`requested`); optional `lot` values prefill the lot allocation. Use **CSV template** for an example. Imported rows are appended and do not replace existing lines.

A USB or Bluetooth barcode scanner that types into a focused field works with the scan box. On compatible HTTPS browsers, **Use camera** can scan common product barcodes. A scan increments the packed quantity on the matching SKU; for an unknown code, it creates a line with one packed unit. For each item, allocate the packed quantity across one or more lot/batch references. The pack summary flags quantity mismatches. Enter a packer name and confirm only after every requested quantity matches and every packed unit has a lot reference. Any later edit clears the confirmation so the check must be repeated.

Use **Print report** to save the selected packing record as PDF, including its lot allocations, photos, notes, and check confirmation. Export a single record or the whole workspace as JSON for backup; **Import backup** adds records without overwriting IDs already in this browser.

The app works offline after it has been opened once from a hosted HTTPS site. No build step, account, analytics, backend, or external API is used. Records and photo attachments are stored in the current browser on this device. Exported JSON can contain customer, order, and photo data; store backups carefully.

## Important limitations

- Data does not sync between devices or team members. Back up records before clearing browser storage or changing devices.
- Confirmation and timestamps are stored locally and use the device clock; they are not tamper-proof and do not prove identity or chain of custody.
- PackProof is not a certified chain-of-custody, inventory, shipping, safety, or compliance system. Confirm records and customer requirements independently.
- Do not store sensitive customer or regulated product details on shared devices.
- Camera barcode scanning depends on browser support; a keyboard-style scanner or manual entry is the fallback.

## Development

Static HTML, CSS, and JavaScript; no dependencies or build tools. Run locally with:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Camera scanning and service-worker installation require HTTPS or localhost.

## License

MIT. See [LICENSE](LICENSE).
