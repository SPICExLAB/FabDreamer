import React from 'react';
import useImage from 'use-image';
import SegmentedEntity from './SegmentedEntity';

const SegmentedEntityWrapper = ({
  entity,
  images,
  isInEditingSection,
  isTracing = false,
  isSubSegmenting = false,
  ...props
}) => {
  const rootId = entity.id.split('-edit-')[0];
  const rootEntity =
    images
      .flatMap((image) => image.segments)
      .find((segment) => segment.id === rootId) || entity;

  const [defaultImage] = useImage(rootEntity.svgUrl);
  const [styledImage] = useImage(
    isInEditingSection ? entity.styledSvg : rootEntity.svgUrl
  );

  if (!defaultImage) {
    return null;
  }

  return (
    <SegmentedEntity
      entity={{
        ...entity,
        image: defaultImage,
        styledImage,
        currentStyle: entity.currentStyle,
      }}
      rootEntity={rootEntity}
      isInEditingSection={isInEditingSection}
      isTracing={isTracing}
      isSubSegmenting={isSubSegmenting}
      {...props}
    />
  );
};

export default React.memo(SegmentedEntityWrapper);
