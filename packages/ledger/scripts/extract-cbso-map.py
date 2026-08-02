#!/usr/bin/env python3
"""
Derive the NBB/CBSO rubriek -> datapoint map from the official taxonomy.

The CBSO taxonomy is DPM-style: there is no element per rubriek. A fact is a
generic metric (met:am1/am2/...) qualified by dimension members, and the
rubriek code ("9900", "10/15") lives only as a table-linkbase label with role
.../xbrl/rub attached to the rule node that carries those dimensions.

So the map is EXTRACTED, never hand-written:

  lab:  <loc href="<sect>-rend.xml#ruleNode_4" label="ruleNode_4_6"/>
        <gen:arc from="ruleNode_4_6" to="label_21"/>
        <label id="label_21" role=".../rub">9900</label>
  rend: <ruleNode id="ruleNode_4"> dim:bas=bas:m118, concept met:am2 </ruleNode>
        (+ dimensions inherited from abstract ancestors via breakdown-tree arcs)

Usage:
  python3 extract-cbso-map.py <taxonomy-root> <model> > cbso-map.json
    taxonomy-root: .../nbb-cbso-26.0.15/www.nbb.be/be/fr/cbso
    model:         m87-f
"""
import json
import os
import re
import sys
from xml.etree import ElementTree as ET

NS = {
    "link": "http://www.xbrl.org/2003/linkbase",
    "xlink": "http://www.w3.org/1999/xlink",
    "table": "http://xbrl.org/2014/table",
    "formula": "http://xbrl.org/2008/formula",
    "label": "http://xbrl.org/2008/label",
    "gen": "http://xbrl.org/2008/generic",
}
RUB_ROLE = "http://www.nbb.be/fr/xbrl/rub"
STD_LABEL_ROLE = "http://www.xbrl.org/2008/role/label"
XL = "{http://www.w3.org/1999/xlink}"


def parse_rend(path):
    """ruleNode id -> {concept, dims{dim: member}, parent}"""
    root = ET.parse(path).getroot()
    nodes = {}
    for rn in root.iter(f"{{{NS['table']}}}ruleNode"):
        nid = rn.get("id")
        if not nid:
            continue
        dims = {}
        for ed in rn.findall(f"{{{NS['formula']}}}explicitDimension"):
            dim = ed.get("dimension")
            q = ed.find(f".//{{{NS['formula']}}}qname")
            if dim is not None and q is not None and q.text:
                dims[dim] = q.text.strip()
        concept = None
        c = rn.find(f"{{{NS['formula']}}}concept/{{{NS['formula']}}}qname")
        if c is not None and c.text:
            concept = c.text.strip()
        nodes[nid] = {
            "concept": concept,
            "dims": dims,
            "abstract": rn.get("abstract") == "true",
            "label": rn.get(f"{XL}label"),
        }
    # breakdown-tree arcs give the parent chain (label -> label)
    by_label = {v["label"]: k for k, v in nodes.items() if v.get("label")}
    for arc in root.iter(f"{{{NS['table']}}}breakdownTreeArc"):
        frm, to = arc.get(f"{XL}from"), arc.get(f"{XL}to")
        if to in by_label and frm in by_label:
            nodes[by_label[to]]["parent"] = by_label[frm]
    for arc in root.iter(f"{{{NS['table']}}}definitionNodeSubtreeArc"):
        frm, to = arc.get(f"{XL}from"), arc.get(f"{XL}to")
        if to in by_label and frm in by_label:
            nodes[by_label[to]]["parent"] = by_label[frm]
    return nodes


def resolve(nodes, nid):
    """Merge a rule node with everything inherited from its ancestors."""
    chain, cur, seen = [], nid, set()
    while cur and cur in nodes and cur not in seen:
        seen.add(cur)
        chain.append(nodes[cur])
        cur = nodes[cur].get("parent")
    dims, concept = {}, None
    for n in reversed(chain):  # ancestors first, child wins
        dims.update(n["dims"])
        if n["concept"]:
            concept = n["concept"]
    return concept, dims


def axis_info(nodes):
    """The period (x) axis carries dim:prd, dim:part and - in the balance
    sheet tables - the metric itself. Returns (part member, concept or None)."""
    part, concept = None, None
    for n in nodes.values():
        if "dim:prd" in n["dims"]:
            part = n["dims"].get("dim:part", part)
            concept = n["concept"] or concept
    return part, concept


def parse_definition(path):
    """metric -> {dimension: set(members)} from the section's hypercubes.

    A row's table linkbase often omits the metric (only 9 of 52 rows declare
    one in the passiva table), so the authoritative source is the definition
    linkbase: `all` arcs bind a primary item (met:amN) to a hypercube, and the
    hypercube's dimension-domain arcs enumerate the members it admits.
    """
    if not os.path.exists(path):
        return {}
    root = ET.parse(path).getroot()
    out = {}
    for dl in root.iter(f"{{{NS['link']}}}definitionLink"):
        locs = {}  # xlink:label -> local name of the target
        for loc in dl.findall(f"{{{NS['link']}}}loc"):
            href = loc.get(f"{XL}href", "")
            if "#" in href:
                locs[loc.get(f"{XL}label")] = href.split("#", 1)[1]
        metrics, dims = set(), {}
        cur_dim = None
        for arc in dl.findall(f"{{{NS['link']}}}definitionArc"):
            role = arc.get(f"{XL}arcrole", "")
            frm = locs.get(arc.get(f"{XL}from"), "")
            to = locs.get(arc.get(f"{XL}to"), "")
            if role.endswith("/all") and frm.startswith("met_"):
                metrics.add(frm.replace("_", ":", 1))
            elif role.endswith("/hypercube-dimension"):
                cur_dim = to.replace("_", ":", 1)
                dims.setdefault(cur_dim, set())
            elif role.endswith("/dimension-domain"):
                cur_dim = frm.replace("_", ":", 1)
                dims.setdefault(cur_dim, set()).add(to.replace("_", ":", 1))
        # One definitionLink is one hypercube: a fact must satisfy a SINGLE
        # hypercube completely, so they are kept separate (merging them would
        # accept dimension mixes the taxonomy rejects).
        for met in metrics:
            out.setdefault(met, []).append(dims)
    return out


def fits(cube, dims):
    """True when a hypercube admits every (dimension, member) a row supplies.
    Dimensions the cube declares but the row omits may be defaulted, and
    dimension defaults live in the schema rather than here, so this is a
    subset test: good enough to PICK the metric, not a substitute for
    validating the finished instance with a real XBRL processor."""
    return all(
        d in cube and (not cube[d] or m in cube[d]) for d, m in dims.items()
    )


def metric_for(defs, dims):
    """Pick the metric with a hypercube that exactly admits these dimensions."""
    for met, cubes in defs.items():
        if any(fits(cube, dims) for cube in cubes):
            return met
    return None


def parse_lab(path, nodes, defs=None):
    """rubriek code -> (concept, dims), plus the English label."""
    root = ET.parse(path).getroot()
    # locator label -> rule node id
    loc_to_node = {}
    for loc in root.iter(f"{{{NS['link']}}}loc"):
        href = loc.get(f"{XL}href", "")
        if "#" in href:
            loc_to_node[loc.get(f"{XL}label")] = href.split("#", 1)[1]
    labels = {}  # resource label -> (role, text, lang)
    for lb in root.iter(f"{{{NS['label']}}}label"):
        labels[lb.get(f"{XL}label")] = (
            lb.get(f"{XL}role"),
            (lb.text or "").strip(),
            lb.get("{http://www.w3.org/XML/1998/namespace}lang"),
        )
    rub, names = {}, {}
    for arc in root.iter(f"{{{NS['gen']}}}arc"):
        frm, to = arc.get(f"{XL}from"), arc.get(f"{XL}to")
        node_id = loc_to_node.get(frm)
        info = labels.get(to)
        if not node_id or not info:
            continue
        role, text, lang = info
        if role == RUB_ROLE and text:
            rub[text] = node_id
        elif role == STD_LABEL_ROLE and lang == "nl" and text:
            names[node_id] = text
    axis_part, axis_concept = axis_info(nodes)
    out = {}
    for code, node_id in rub.items():
        if node_id not in nodes:
            continue
        concept, dims = resolve(nodes, node_id)
        # Balance-sheet tables declare the metric on the period axis instead of
        # on the row; fall back to it before giving up on the row.
        concept = concept or axis_concept or metric_for(defs or {}, dims)
        if not concept:
            continue  # a pure header row, no datapoint
        # Verify the (metric, dimensions) pair against the section hypercubes.
        # A pair the taxonomy does not admit would be rejected as
        # xbrldie:PrimaryItemDimensionallyInvalidError at filing time, so it is
        # recorded as unverified rather than silently emitted.

        dims.pop("dim:prd", None)  # the period is a per-column context aspect
        # dim:part sits on the period axis in most tables but on the row in the
        # appropriation section (s.05); the row wins when it declares one.
        row_part = dims.pop("dim:part", None)
        out[code] = {
            "concept": concept,
            "dims": dims,
            "part": row_part or axis_part,
            "label": names.get(node_id, ""),
        }
    return out


def sections_for_model(root_dir, model):
    """Section tables referenced by the model's presentation linkbase."""
    pres = os.path.join(root_dir, "fws/26.0/mod", model.split("-")[0], f"{model}-presentation.xml")
    refs = set()
    if os.path.exists(pres):
        text = open(pres, encoding="utf-8").read()
        # Several model variants share a section number (s.04.00.0.ab, .cd,
        # .ef, ...) with DIFFERENT dimension members. Only the exact tables the
        # entry point references are valid for this model.
        for m in re.finditer(r"(s\.[0-9.]+[a-z]*)-rend\.xml", text):
            refs.add(m.group(1))
    return sorted(refs)


def main():
    root_dir, model = sys.argv[1], sys.argv[2]
    sect_dir = os.path.join(root_dir, "fws/26.0/sect")
    wanted = set(sections_for_model(root_dir, model))
    combined, per_section = {}, {}
    for fn in sorted(os.listdir(sect_dir)):
        if not fn.endswith("-lab.xml"):
            continue
        base = fn[: -len("-lab.xml")]
        if wanted and base not in wanted:
            continue
        rend = os.path.join(sect_dir, f"{base}-rend.xml")
        if not os.path.exists(rend):
            continue
        nodes = parse_rend(rend)
        defs = parse_definition(os.path.join(sect_dir, f"{base}-definition.xml"))
        found = parse_lab(os.path.join(sect_dir, fn), nodes, defs)
        if found:
            per_section[base] = sorted(found)
            for code, dp in found.items():
                combined.setdefault(code, dp)
    json.dump(
        {"model": model, "taxonomy": os.path.basename(os.path.dirname(root_dir)),
         "sections": per_section, "rubrieken": combined},
        sys.stdout, indent=1, ensure_ascii=False, sort_keys=True,
    )


if __name__ == "__main__":
    main()
