const SUPPORTED_RELATIONS = new Set(["WIFE", "HUSBAND", "SON", "DAUGHTER"]);
const RELATION_GENDER_MAP = {
  WIFE: "FEMALE",
  HUSBAND: "MALE",
  SON: "MALE",
  DAUGHTER: "FEMALE",
};

function gcd(a, b) {
  let x = Math.abs(Number(a) || 0);
  let y = Math.abs(Number(b) || 0);
  while (y) {
    const temp = x % y;
    x = y;
    y = temp;
  }
  return x || 1;
}

function reduceFraction(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 1);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return { numerator: 0, denominator: 1 };
  }
  const sign = n < 0 || d < 0 ? -1 : 1;
  const absN = Math.abs(n);
  const absD = Math.abs(d);
  const divisor = gcd(absN, absD);
  return {
    numerator: sign * (absN / divisor),
    denominator: absD / divisor,
  };
}

function multiplyFraction(a, b) {
  return reduceFraction(
    Number(a?.numerator || 0) * Number(b?.numerator || 0),
    Number(a?.denominator || 1) * Number(b?.denominator || 1)
  );
}

function subtractFraction(a, b) {
  const common = Number(a?.denominator || 1) * Number(b?.denominator || 1);
  const left = Number(a?.numerator || 0) * Number(b?.denominator || 1);
  const right = Number(b?.numerator || 0) * Number(a?.denominator || 1);
  return reduceFraction(left - right, common);
}

function fractionToDecimal(fraction) {
  const denominator = Number(fraction?.denominator || 1);
  if (!denominator) return 0;
  return Number(fraction?.numerator || 0) / denominator;
}

function fractionToPercent(fraction) {
  return Number((fractionToDecimal(fraction) * 100).toFixed(4));
}

function fractionToText(fraction) {
  const normalized = reduceFraction(
    Number(fraction?.numerator || 0),
    Number(fraction?.denominator || 1)
  );
  return `${normalized.numerator}/${normalized.denominator}`;
}

function normalizeRelationType(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function normalizeOwnerGender(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "MALE" || normalized === "FEMALE") return normalized;
  return "";
}

function expectedGenderForRelation(relationType) {
  return RELATION_GENDER_MAP[relationType] || "";
}

function normalizeFamilyMember(row = {}) {
  const relationType = normalizeRelationType(row.relation_type || row.relationType);
  const gender = normalizeOwnerGender(row.gender);
  return {
    familyMemberId: row.family_member_id || row.familyMemberId || null,
    linkedUserId: row.linked_user_id || row.linkedUserId || null,
    relationType,
    gender: gender || expectedGenderForRelation(relationType) || null,
    fullName: row.full_name || row.fullName || null,
    cnic: row.cnic || null,
    dateOfBirth: row.date_of_birth || row.dateOfBirth || null,
    isMinor: Boolean(row.is_minor ?? row.isMinor),
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
  };
}

function buildMemberAllocation(member, fraction, shareBasis, allocationKind) {
  return {
    familyMemberId: member.familyMemberId || null,
    linkedUserId: member.linkedUserId || null,
    relationType: member.relationType,
    gender: member.gender || expectedGenderForRelation(member.relationType) || null,
    fullName: member.fullName || "Family Member",
    cnic: member.cnic || null,
    dateOfBirth: member.dateOfBirth || null,
    isMinor: Boolean(member.isMinor),
    shareNumerator: fraction.numerator,
    shareDenominator: fraction.denominator,
    sharePercent: fractionToPercent(fraction),
    shareFractionText: fractionToText(fraction),
    shareBasis,
    allocationKind,
  };
}

function describeSpouseBasis(ownerGender, hasChildren, spouseCount) {
  if (ownerGender === "MALE") {
    if (hasChildren) {
      return spouseCount > 1
        ? `Wives collectively receive fixed 1/8 because children are present; each wife receives an equal split`
        : `Wife receives fixed 1/8 because children are present`;
    }
    return spouseCount > 1
      ? `Wives collectively receive fixed 1/4 because no child is present; each wife receives an equal split`
      : `Wife receives fixed 1/4 because no child is present`;
  }

  if (hasChildren) {
    return `Husband receives fixed 1/4 because children are present`;
  }

  return `Husband receives fixed 1/2 because no child is present`;
}

class SuccessionRuleService {
  getSupportedRelations() {
    return Array.from(SUPPORTED_RELATIONS.values());
  }

  getAllowedRelations(ownerGender) {
    const normalizedOwnerGender = normalizeOwnerGender(ownerGender);
    if (normalizedOwnerGender === "MALE") {
      return ["WIFE", "SON", "DAUGHTER"];
    }
    if (normalizedOwnerGender === "FEMALE") {
      return ["SON", "DAUGHTER"];
    }
    return ["SON", "DAUGHTER"];
  }

  buildIslamicFamilyPreview({ ownerGender, familyMembers = [] } = {}) {
    const normalizedOwnerGender = normalizeOwnerGender(ownerGender);
    const activeMembers = familyMembers
      .map((item) => normalizeFamilyMember(item))
      .filter((item) => item.isActive && SUPPORTED_RELATIONS.has(item.relationType));

    const warnings = [];
    const blockers = [];

    if (!normalizedOwnerGender) {
      blockers.push("Owner gender is required to calculate spouse entitlement.");
    }

    const wives = activeMembers.filter((item) => item.relationType === "WIFE");
    const husbands = activeMembers.filter((item) => item.relationType === "HUSBAND");
    const sons = activeMembers.filter((item) => item.relationType === "SON");
    const daughters = activeMembers.filter((item) => item.relationType === "DAUGHTER");
    const children = [...sons, ...daughters];
    const hasChildren = children.length > 0;

    for (const member of activeMembers) {
      const expectedGender = expectedGenderForRelation(member.relationType);
      if (member.gender && expectedGender && member.gender !== expectedGender) {
        blockers.push(
          `${member.fullName || "Family member"} has relation ${member.relationType}, but stored gender does not match that relation.`
        );
      }
    }

    if (normalizedOwnerGender === "MALE" && husbands.length > 0) {
      blockers.push("A male owner cannot distribute succession through a HUSBAND relation. Use WIFE for spouse records.");
    }
    if (normalizedOwnerGender === "FEMALE" && (wives.length > 0 || husbands.length > 0)) {
      blockers.push("For a female owner, this project currently accepts children details only.");
    }

    const spouseMembers =
      normalizedOwnerGender === "MALE"
        ? wives
        : [];

    if (!spouseMembers.length && !children.length) {
      blockers.push("Add at least one spouse or child in family members before calculating shares.");
    }

    const allocations = [];
    let spousePool = reduceFraction(0, 1);

    if (spouseMembers.length > 0 && normalizedOwnerGender) {
      spousePool = hasChildren ? reduceFraction(1, 8) : reduceFraction(1, 4);

      const spouseCount = spouseMembers.length;
      const individualSpouseFraction = multiplyFraction(
        spousePool,
        reduceFraction(1, spouseCount)
      );
      const spouseBasis = describeSpouseBasis(
        normalizedOwnerGender,
        hasChildren,
        spouseCount
      );

      for (const spouse of spouseMembers) {
        allocations.push(
          buildMemberAllocation(
            spouse,
            individualSpouseFraction,
            spouseBasis,
            "FIXED_SPOUSE_SHARE"
          )
        );
      }
    }

    if (children.length > 0) {
      const remainingEstate = subtractFraction(reduceFraction(1, 1), spousePool);
      const unitCount = sons.length * 2 + daughters.length;

      if (unitCount <= 0) {
        blockers.push("Children are present but their share units could not be calculated.");
      } else {
        const unitFraction = multiplyFraction(remainingEstate, reduceFraction(1, unitCount));
        const remainderText = fractionToText(remainingEstate);

        for (const son of sons) {
          const sonFraction = multiplyFraction(unitFraction, reduceFraction(2, 1));
          allocations.push(
            buildMemberAllocation(
              son,
              sonFraction,
              `Son receives 2 child units from the remaining ${remainderText} estate after spouse share`,
              "CHILD_RESIDUARY_SHARE"
            )
          );
        }

        for (const daughter of daughters) {
          allocations.push(
            buildMemberAllocation(
              daughter,
              unitFraction,
              `Daughter receives 1 child unit from the remaining ${remainderText} estate after spouse share`,
              "CHILD_RESIDUARY_SHARE"
            )
          );
        }
      }
    } else if (spouseMembers.length > 0) {
      warnings.push(
        "Spouse fixed share is shown, but the remaining estate classes are not modeled yet in this project. Submission is allowed only when the calculated allocation reaches 100%."
      );
    }

    const totalAllocatedPercent = Number(
      allocations.reduce((sum, item) => sum + Number(item.sharePercent || 0), 0).toFixed(4)
    );
    const canSubmit =
      blockers.length === 0 &&
      Math.abs(totalAllocatedPercent - 100) < 0.01 &&
      allocations.length > 0;

    if (!canSubmit && blockers.length === 0 && Math.abs(totalAllocatedPercent - 100) >= 0.01) {
      warnings.push(
        `Current calculated allocation covers ${totalAllocatedPercent}% of the estate. Add the remaining supported heirs before submission.`
      );
    }

    return {
      ownerGender: normalizedOwnerGender || null,
      supportedRelations: this.getSupportedRelations(),
      familySummary: {
        wives: wives.length,
        husbands: husbands.length,
        sons: sons.length,
        daughters: daughters.length,
        children: children.length,
      },
      allocations,
      totalAllocatedPercent,
      totalHeirs: allocations.length,
      shareSnapshot: allocations,
      warnings,
      blockers,
      canSubmit,
      scenarioLabel: spouseMembers.length && children.length
        ? "Spouse and children allocation"
        : children.length
        ? "Children-only allocation"
        : spouseMembers.length
        ? "Spouse fixed-share preview"
        : "No supported heirs",
    };
  }
}

export default new SuccessionRuleService();
