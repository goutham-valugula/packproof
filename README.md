# PackProof

**Keep each shipment’s packing record together.** PackProof is a local-first packing record helper for small warehouse teams who need to keep item counts, lot references, and shipment photos together per order—without replacing their inventory system.

**Live app:** https://goutham-valugula.github.io/packproof/

## The problem signal

A small-business warehouse operator described shipping 25–30 pallets a week while manually recording each order’s quantities and lot numbers in Google Sheets and keeping shipment photos on a separate phone. When customers disputed missing items, the evidence was split across those tools. The post asked for per-order scanning and an exportable report: [Inventory Management System — r/smallbusiness](https://www.reddit.com/r/smallbusiness/comments/1udj3wa/inventory_management_system/).

Inventory products already offer barcode and lot tracking. For example, [HandiFox](https://www.handifox.com/pricing) combines mobile barcode workflows with order fulfillment and lot tracking, and [Invenva](https://invenva.com/) offers stock movement, order checklists, barcode scanning, photos, and reports. PackProof takes a narrower approach: capture a per-shipment packing check and photo set locally, then make a printable record. It does not maintain stock balances or sync with those systems. This is an initial release based on a problem report, not proof of broad market demand.

## Use it

Open the [live app](https://goutham-valugula.github.io/packproof/) or `index.html` in a modern browser. Create a shipment, add order lines, enter requested/packed quantities and lot references, and attach photos. Use **Print report** to save a PDF, or export the selected record/workspace as JSON for backup. Use **Import backup** to restore exported records into another browser; imports are added without overwriting existing IDs.

A USB or Bluetooth barcode scanner that types into a focused field works with the scan box. On compatible HTTPS browsers, **Use camera** can scan common product barcodes. A scan increments the packed count for a matching SKU; for an unknown code, it creates a new line with a packed count of one. Enter the expected count and lot reference afterward.

The app works offline after it has been opened once from a hosted HTTPS site. No build step, account, analytics, backend, or external API is used. Records and photo attachments are stored in the current browser on this device. Exported JSON can contain customer, order, and photo data; store backups carefully.

## Important limitations

- Data does not sync between devices or team members. Back up records before clearing browser storage or changing devices.
- Local timestamps use the device clock and are not tamper-proof.
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
